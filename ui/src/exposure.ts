/**
 * Exposure: what a node has open to the internet, computed from evidence.
 *
 * The first question an operator asks a firewall panel is "what is reachable
 * from outside right now, on which machine". Neither half of NetGuard answers
 * it alone: a reality snapshot lists sockets without saying whether anything
 * confines them, and a binding lists rules without saying whether anything is
 * listening behind them. This module joins the two per node and folds the
 * result into the sentence the table prints.
 *
 * The classification mirrors the server's suggestion engine
 * (lattice-server/internal/netguard/suggest.go): a listener belongs to the
 * public zone when it binds an unspecified address, to the loopback zone when
 * it binds a loopback address, and otherwise to the zone of the interface that
 * owns its address. One rule is stricter here than there. The server treats a
 * cidr, node or group remote as "allowed from anywhere in zone terms"; this
 * module treats only `any` and a public cidr as opening a port to the
 * internet, because "22 from 10.7.0.0/24" does not.
 *
 * One rule is added that the server does not need: whether the compiled table
 * is actually live. On a managed node whose live table matches what Lattice
 * applied, a listener no rule covers is dropped by the default policy and is
 * therefore closed. Everywhere else (legacy baseline, observe only, no
 * binding, drifted) nothing Lattice knows about confines it, and it is red.
 *
 * Everything here is pure and DOM-free.
 */

import type {
  GuardInterface,
  GuardListener,
  GuardNode,
  GuardNodeReality,
  GuardRule,
  GuardZone,
  Remote,
  SecurityGroup,
} from "./netguardModel";
import type { PostureRow } from "./posture";

export type Protocol = "tcp" | "udp";

/** Why an internet-reachable port is listed the way it is. */
export type Verdict = "allowed" | "unexplained";

export interface Span {
  protocol: Protocol;
  from: number;
  to: number;
  /** Owning process names, deduplicated, empty when the agent could not read them. */
  processes: string[];
}

/** A port reachable from the internet. */
export interface OpenSpan extends Span {
  verdict: Verdict;
}

/** A port that is listening but reachable only from a stated scope. */
export interface ConfinedSpan extends Span {
  /** Human labels: "the wireguard zone", "10.7.0.0/24", "closed by policy". */
  scopes: string[];
}

export type ManagedBy =
  | { kind: "groups"; names: string[] }
  | { kind: "legacy"; names: string[] }
  | { kind: "none" };

/**
 * How much the spans can be trusted. "none" means no snapshot exists, and the
 * spans are empty because nobody has looked, never because nothing is open.
 */
export type Evidence = "fresh" | "stale" | "none";

export interface NodeExposure {
  nodeId: string;
  evidence: Evidence;
  collectedAt?: string;
  open: OpenSpan[];
  confined: ConfinedSpan[];
  /** Number of ports (not spans) that are open with nothing explaining them. */
  unexplained: number;
  managedBy: ManagedBy;
  /** True when the table Lattice compiled is believed to be what the node runs. */
  enforced: boolean;
}

export interface ExposureContext {
  groups: readonly SecurityGroup[];
  zones: readonly GuardZone[];
  /** node id to display name, for "from node X" scopes. */
  nodeNames?: ReadonlyMap<string, string>;
}

export const PUBLIC_ZONE = "public";
export const LOOPBACK_ZONE = "loopback";
const OVERLAY_ZONES = ["wireguard", "tailscale"] as const;
/** The server resolves these before any custom zone, in this order. */
const ZONE_PRIORITY = [LOOPBACK_ZONE, PUBLIC_ZONE, ...OVERLAY_ZONES];

// ── addresses ───────────────────────────────────────────────────────────────
//
// A small parser rather than a dependency: the plugin needs containment tests
// for a handful of well-known ranges and the node's own interface prefixes,
// which is arithmetic on a 32-bit or 128-bit integer.

interface Addr {
  v: 4 | 6;
  n: bigint;
}

interface Prefix {
  addr: Addr;
  bits: number;
}

function parseV4(value: string): Addr | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return undefined;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  let n = 0n;
  for (const part of parts) n = (n << 8n) | BigInt(part);
  return { v: 4, n };
}

function parseV6(raw: string): Addr | undefined {
  let text = raw;
  const zoneIndex = text.indexOf("%");
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  // A trailing dotted quad (::ffff:10.0.0.1) is two hextets.
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (!v4) return undefined;
    const n = Number(v4.n);
    text = `${text.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...(halves.length === 2 ? new Array<string>(missing).fill("0") : []), ...tail];
  if (groups.length !== 8) return undefined;
  let n = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    n = (n << 16n) | BigInt(parseInt(group, 16));
  }
  return { v: 6, n };
}

/** An IPv4 or IPv6 address; undefined for "", "*", or anything unparseable. */
export function parseAddress(raw: string | undefined): Addr | undefined {
  const value = (raw ?? "").trim().replace(/^\[|\]$/g, "");
  if (!value || value === "*") return undefined;
  return value.includes(":") ? parseV6(value) : parseV4(value);
}

function parsePrefix(raw: string | undefined): Prefix | undefined {
  const [addrText, bitsText] = (raw ?? "").trim().split("/");
  const addr = parseAddress(addrText);
  if (!addr) return undefined;
  const max = addr.v === 4 ? 32 : 128;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return undefined;
  return { addr, bits };
}

function contains(prefix: Prefix, addr: Addr): boolean {
  if (prefix.addr.v !== addr.v) return false;
  const shift = BigInt((addr.v === 4 ? 32 : 128) - prefix.bits);
  return prefix.addr.n >> shift === addr.n >> shift;
}

function isLoopback(addr: Addr): boolean {
  return addr.v === 4 ? addr.n >> 24n === 127n : addr.n === 1n;
}

/**
 * Ranges the internet cannot route to. A cidr remote inside one of these
 * scopes a rule to a private network; anything else opens the port to the
 * world, and so does 0.0.0.0/0 or ::/0, whose network address is in none of
 * them.
 */
const PRIVATE_PREFIXES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "127.0.0.0/8",
  "fc00::/7",
  "fe80::/10",
  "::1/128",
]
  .map(parsePrefix)
  .filter((prefix): prefix is Prefix => prefix !== undefined);

/** True when a cidr reaches the port from the public internet. */
export function isPublicCidr(cidr: string | undefined): boolean {
  const prefix = parsePrefix(cidr);
  if (!prefix) return false;
  return !PRIVATE_PREFIXES.some((candidate) => contains(candidate, prefix.addr));
}

// ── zones ───────────────────────────────────────────────────────────────────

interface InterfaceFacts {
  name: string;
  prefixes: Prefix[];
}

function indexInterfaces(interfaces: readonly GuardInterface[] | undefined): InterfaceFacts[] {
  const out: InterfaceFacts[] = [];
  for (const iface of interfaces ?? []) {
    const name = (iface.name ?? "").trim();
    if (!name) continue;
    const prefixes = (iface.addresses ?? [])
      .map(parsePrefix)
      .filter((prefix): prefix is Prefix => prefix !== undefined);
    out.push({ name, prefixes });
  }
  return out;
}

/** The interface owning an address: exact match first, then the longest prefix. */
function interfaceFor(addr: Addr, interfaces: readonly InterfaceFacts[]): string {
  for (const iface of interfaces) {
    if (iface.prefixes.some((prefix) => prefix.addr.v === addr.v && prefix.addr.n === addr.n)) return iface.name;
  }
  let best = "";
  let bestBits = -1;
  for (const iface of interfaces) {
    for (const prefix of iface.prefixes) {
      if (contains(prefix, addr) && prefix.bits > bestBits) {
        best = iface.name;
        bestBits = prefix.bits;
      }
    }
  }
  return best;
}

function zoneIdsByPriority(zones: ReadonlyMap<string, GuardZone>): string[] {
  const ordered = ZONE_PRIORITY.filter((id) => zones.has(id));
  const custom = [...zones.keys()].filter((id) => !ZONE_PRIORITY.includes(id)).sort();
  return [...ordered, ...custom];
}

function zoneForInterface(zones: ReadonlyMap<string, GuardZone>, iface: string): string {
  if (!iface) return "";
  for (const id of zoneIdsByPriority(zones)) {
    if ((zones.get(id)?.interfaces ?? []).includes(iface)) return id;
  }
  return "";
}

function zoneForAddress(zones: ReadonlyMap<string, GuardZone>, addr: Addr): string {
  let best = "";
  let bestBits = -1;
  for (const id of zoneIdsByPriority(zones)) {
    for (const raw of zones.get(id)?.cidrs ?? []) {
      const prefix = parsePrefix(raw);
      if (prefix && contains(prefix, addr) && prefix.bits > bestBits) {
        best = id;
        bestBits = prefix.bits;
      }
    }
  }
  return best;
}

/** The zone a listener is reachable through, exactly as the server decides it. */
export function listenerZone(
  listener: GuardListener,
  zones: ReadonlyMap<string, GuardZone>,
  interfaces: readonly InterfaceFacts[],
): string {
  const addr = parseAddress(listener.address);
  if (!addr || addr.n === 0n) return PUBLIC_ZONE;
  if (isLoopback(addr)) return LOOPBACK_ZONE;
  const iface = interfaceFor(addr, interfaces);
  return zoneForInterface(zones, iface) || zoneForAddress(zones, addr) || PUBLIC_ZONE;
}

// ── rules ───────────────────────────────────────────────────────────────────

export interface RemoteScope {
  /** "public" reaches the port from the internet; "scoped" from somewhere narrower. */
  kind: "public" | "scoped";
  /** A label that reads after "from": "anywhere", "10.7.0.0/24", "the wireguard zone". */
  label: string;
}

export function remoteScope(remote: Remote | undefined, ctx: ExposureContext): RemoteScope {
  const kind = remote?.kind ?? "any";
  switch (kind) {
    case "any":
    case "":
      return { kind: "public", label: "anywhere" };
    case "cidr": {
      const cidr = (remote?.cidr ?? "").trim();
      return isPublicCidr(cidr) ? { kind: "public", label: cidr } : { kind: "scoped", label: cidr || "an empty cidr" };
    }
    case "node": {
      const id = remote?.node_id ?? "";
      return { kind: "scoped", label: `node ${ctx.nodeNames?.get(id) || id || "?"}` };
    }
    case "group": {
      const id = remote?.group_id ?? "";
      const name = ctx.groups.find((group) => group.id === id)?.name || id || "?";
      return { kind: "scoped", label: `group ${name}` };
    }
    case "zone": {
      const id = remote?.zone_id ?? "";
      const name = ctx.zones.find((zone) => zone.id === id)?.name || id || "?";
      return { kind: "scoped", label: `the ${name} zone` };
    }
    case "domain":
      return { kind: "scoped", label: remote?.domain || "a domain" };
    default:
      return { kind: "scoped", label: kind };
  }
}

/** True when an enabled allow-ingress rule lets this protocol and port in. */
export function ruleCovers(rule: GuardRule, protocol: Protocol, port: number): boolean {
  if (rule.disabled || rule.action !== "allow" || rule.direction !== "ingress") return false;
  if (rule.protocol !== "any" && rule.protocol !== protocol) return false;
  const ports = rule.ports ?? [];
  return ports.length === 0 || ports.some((range) => range.from <= port && port <= range.to);
}

/**
 * The rules that apply to a node: binding overrides, then the groups the
 * server resolved for it (which include a legacy node-private baseline), then
 * any bound group the server did not resolve, looked up in the overview.
 */
export function nodeRules(row: PostureRow, ctx: ExposureContext): GuardRule[] {
  const intent = row.intent;
  const rules: GuardRule[] = [...(intent?.binding?.overrides ?? [])];
  const seen = new Set<string>();
  for (const group of intent?.groups ?? []) {
    seen.add(group.id);
    rules.push(...(group.rules ?? []));
  }
  for (const id of intent?.binding?.group_ids ?? []) {
    if (seen.has(id)) continue;
    const group = ctx.groups.find((candidate) => candidate.id === id);
    if (group) rules.push(...(group.rules ?? []));
  }
  return rules;
}

/**
 * Whether the compiled table is believed to be live on the node. "in sync"
 * is the only drift state that proves it: both hashes exist and agree.
 */
export function isEnforced(row: PostureRow): boolean {
  return row.coverage === "managed" && row.driftState === "in_sync";
}

export function managedBy(row: PostureRow, ctx: ExposureContext): ManagedBy {
  const intent = row.intent;
  if (row.coverage === "legacy") {
    return { kind: "legacy", names: (intent?.groups ?? []).map((group) => group.name || group.id) };
  }
  const ids = intent?.binding?.group_ids ?? [];
  if (!ids.length) return { kind: "none" };
  const names = ids.map(
    (id) => intent?.groups?.find((group) => group.id === id)?.name || ctx.groups.find((group) => group.id === id)?.name || id,
  );
  return { kind: "groups", names };
}

// ── classification ──────────────────────────────────────────────────────────

interface Entry {
  protocol: Protocol;
  port: number;
  processes: Set<string>;
  kind: "open" | "confined";
  verdict?: Verdict;
  scopes?: string[];
}

/** Higher means more exposed; used when one port is bound on several addresses. */
function exposureRank(entry: Entry): number {
  if (entry.kind === "open") return entry.verdict === "unexplained" ? 2 : 1;
  return 0;
}

function normalizeListener(listener: GuardListener): { protocol: Protocol; port: number } | undefined {
  const protocol = (listener.protocol ?? "").trim().toLowerCase();
  const port = listener.port ?? 0;
  if ((protocol !== "tcp" && protocol !== "udp") || port < 1 || port > 65535) return undefined;
  return { protocol, port };
}

function zoneLabel(id: string, zones: ReadonlyMap<string, GuardZone>): string {
  return `the ${zones.get(id)?.name || id} zone`;
}

function classify(
  listener: GuardListener,
  row: PostureRow,
  rules: readonly GuardRule[],
  zones: ReadonlyMap<string, GuardZone>,
  interfaces: readonly InterfaceFacts[],
  enforced: boolean,
  ctx: ExposureContext,
): Entry | undefined {
  const normalized = normalizeListener(listener);
  if (!normalized) return undefined;
  const zone = listenerZone(listener, zones, interfaces);
  if (zone === LOOPBACK_ZONE) return undefined;
  const processes = new Set<string>();
  const process = (listener.process ?? "").trim();
  if (process) processes.add(process);
  const base = { ...normalized, processes };

  // Bound to an overlay or custom zone address: reachable only through that
  // interface, whatever the rules say.
  if (zone !== PUBLIC_ZONE) return { ...base, kind: "confined", scopes: [zoneLabel(zone, zones)] };

  const matches = rules.filter((rule) => ruleCovers(rule, normalized.protocol, normalized.port));
  const scopes = matches.map((rule) => remoteScope(rule.remote, ctx));
  if (scopes.some((scope) => scope.kind === "public")) return { ...base, kind: "open", verdict: "allowed" };

  // Rules that are live on the box: a compiled table that matches, or the
  // node's own imported baseline.
  const rulesLive = enforced || row.coverage === "legacy";
  if (rulesLive && scopes.length) {
    return { ...base, kind: "confined", scopes: [...new Set(scopes.map((scope) => scope.label))] };
  }
  if (enforced) {
    // Nothing allows it and the default policy drops it. Trusted zones are
    // accepted before the groups run, so a bound zone still reaches it.
    const zoneIds = row.intent?.binding?.zone_ids ?? [];
    const labels = zoneIds.filter((id) => id !== LOOPBACK_ZONE).map((id) => zoneLabel(id, zones));
    return { ...base, kind: "confined", scopes: labels.length ? labels : ["closed by policy"] };
  }
  return { ...base, kind: "open", verdict: "unexplained" };
}

function foldSpans<T extends Span>(
  entries: readonly Entry[],
  keyOf: (entry: Entry) => string,
  finish: (entry: Entry, span: Span) => T,
): T[] {
  const sorted = [...entries].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port);
  const out: T[] = [];
  let current: { key: string; entry: Entry; span: Span } | undefined;
  for (const entry of sorted) {
    const key = keyOf(entry);
    if (current && current.key === key && current.span.to + 1 === entry.port) {
      current.span.to = entry.port;
      for (const process of entry.processes) {
        if (!current.span.processes.includes(process)) current.span.processes.push(process);
      }
      continue;
    }
    if (current) out.push(finish(current.entry, current.span));
    current = {
      key,
      entry,
      span: { protocol: entry.protocol, from: entry.port, to: entry.port, processes: [...entry.processes] },
    };
  }
  if (current) out.push(finish(current.entry, current.span));
  return out.sort((a, b) => a.from - b.from || a.protocol.localeCompare(b.protocol));
}

/**
 * Join one node's intent to its snapshot.
 *
 * `reality` is the node's full snapshot, or undefined when none was fetched.
 * A stale snapshot is still classified, because last week's sockets are
 * better evidence than none, and the result says it is stale so the table
 * can refuse to print it as current.
 */
export function computeExposure(
  row: PostureRow,
  reality: GuardNodeReality | undefined,
  ctx: ExposureContext,
): NodeExposure {
  const managed = managedBy(row, ctx);
  const enforced = isEnforced(row);
  const base = { nodeId: row.nodeId, managedBy: managed, enforced };

  if (!reality || row.snapshotStatus === "unknown") {
    return { ...base, evidence: "none", open: [], confined: [], unexplained: 0 };
  }

  const zones = new Map<string, GuardZone>();
  for (const zone of ctx.zones) zones.set(zone.id, zone);
  for (const zone of row.intent?.zones ?? []) if (!zones.has(zone.id)) zones.set(zone.id, zone);
  const interfaces = indexInterfaces(reality.interfaces);
  const rules = nodeRules(row, ctx);

  // One entry per protocol and port. A socket bound on both 0.0.0.0 and ::,
  // or on loopback and a public address, is one port to the operator, and the
  // most exposed classification wins.
  const byKey = new Map<string, Entry>();
  for (const listener of reality.listeners ?? []) {
    const entry = classify(listener, row, rules, zones, interfaces, enforced, ctx);
    if (!entry) continue;
    const key = `${entry.protocol}/${entry.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    for (const process of entry.processes) existing.processes.add(process);
    if (exposureRank(entry) > exposureRank(existing)) {
      byKey.set(key, { ...entry, processes: existing.processes });
    } else if (existing.kind === "confined" && entry.kind === "confined") {
      existing.scopes = [...new Set([...(existing.scopes ?? []), ...(entry.scopes ?? [])])];
    }
  }

  const entries = [...byKey.values()];
  const open = foldSpans<OpenSpan>(
    entries.filter((entry) => entry.kind === "open"),
    (entry) => `${entry.protocol}:${entry.verdict}`,
    (entry, span) => ({ ...span, verdict: entry.verdict ?? "unexplained" }),
  );
  const confined = foldSpans<ConfinedSpan>(
    entries.filter((entry) => entry.kind === "confined"),
    (entry) => `${entry.protocol}:${(entry.scopes ?? []).join("|")}`,
    (entry, span) => ({ ...span, scopes: entry.scopes ?? [] }),
  );
  const unexplained = open
    .filter((span) => span.verdict === "unexplained")
    .reduce((sum, span) => sum + (span.to - span.from + 1), 0);

  return {
    ...base,
    evidence: row.snapshotStatus === "stale" ? "stale" : "fresh",
    collectedAt: reality.collected_at || row.collectedAt,
    open,
    confined,
    unexplained,
  };
}

// ── formatting ──────────────────────────────────────────────────────────────

/** "22", "31001-31012", "51820/udp". TCP is the default and stays unmarked. */
export function formatSpan(span: Span): string {
  const ports = span.from === span.to ? String(span.from) : `${span.from}-${span.to}`;
  return span.protocol === "udp" ? `${ports}/udp` : ports;
}

export function formatSpans(spans: readonly Span[]): string {
  return spans.map(formatSpan).join(", ");
}

/** "sshd" or "postgres, nginx"; empty when the agent could not read owners. */
export function formatProcesses(span: Span): string {
  return span.processes.join(", ");
}

function joinNatural(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "the wireguard zone and 10.7.0.0/24". */
export function describeScopes(scopes: readonly string[]): string {
  return joinNatural([...new Set(scopes)]);
}

function describePorts(rule: GuardRule): string {
  const protocol = rule.protocol === "any" ? "" : rule.protocol.toUpperCase();
  const ports = (rule.ports ?? [])
    .map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`))
    .join(", ");
  if (rule.protocol === "any") return "everything";
  if (rule.protocol === "icmp" || rule.protocol === "icmpv6") return rule.protocol.toUpperCase();
  return ports ? `${protocol} ${ports}` : `all ${protocol}`;
}

/**
 * One rule as a sentence: "allows TCP 22 from 10.7.0.0/24", "denies TCP 25
 * from anywhere", "allows everything from the wireguard zone", "allows TCP
 * 443 to anywhere" for egress.
 */
export function ruleSentence(rule: GuardRule, ctx: ExposureContext): string {
  const verb = rule.action === "deny" ? "denies" : "allows";
  const preposition = rule.direction === "egress" ? "to" : "from";
  return `${verb} ${describePorts(rule)} ${preposition} ${remoteScope(rule.remote, ctx).label}`;
}

/**
 * What a group lets in, merged per service: "TCP 22 from 10.7.0.0/24 and the
 * wireguard zone". Only enabled allow-ingress rules count, because that is
 * the question the Groups table answers; denies and egress read per rule.
 */
export function allowsPreview(rules: readonly GuardRule[], ctx: ExposureContext): string[] {
  const merged = new Map<string, string[]>();
  for (const rule of rules) {
    if (rule.disabled || rule.action !== "allow" || rule.direction !== "ingress") continue;
    const service = describePorts(rule);
    const label = remoteScope(rule.remote, ctx).label;
    const labels = merged.get(service) ?? [];
    if (!labels.includes(label)) labels.push(label);
    merged.set(service, labels);
  }
  return [...merged.entries()].map(([service, labels]) => `${service} from ${joinNatural(labels)}`);
}

/** How many nodes bind this group or zone. */
export function usedByNodes(nodes: readonly GuardNode[], field: "group_ids" | "zone_ids", id: string): number {
  return nodes.filter((node) => (node.binding?.[field] ?? []).includes(id)).length;
}

// ── findings ────────────────────────────────────────────────────────────────

export interface Finding {
  /** Stable across refreshes, so a session-local dismissal survives a reload of the data. */
  key: string;
  nodeId: string;
  nodeName: string;
  span: OpenSpan;
  /** The fact: "5432 (postgres) is open to the internet and no rule allows it." */
  sentence: string;
  /** What to do about it, in this node's terms. */
  hint: string;
  /** The zone a scoped rule should name, when one exists to name. */
  zoneId?: string;
}

/**
 * The overlay zone a suggestion should point at: one the node already trusts,
 * else one that exists in the overview. Undefined when there is none, in
 * which case the honest suggestion is a rule from a specific cidr.
 */
export function preferredZone(row: PostureRow, ctx: ExposureContext): GuardZone | undefined {
  const bound = row.intent?.binding?.zone_ids ?? [];
  for (const id of OVERLAY_ZONES) {
    if (bound.includes(id)) {
      const zone = ctx.zones.find((candidate) => candidate.id === id);
      if (zone) return zone;
    }
  }
  for (const id of OVERLAY_ZONES) {
    const zone = ctx.zones.find((candidate) => candidate.id === id);
    if (zone) return zone;
  }
  return undefined;
}

function spanSubject(span: OpenSpan): string {
  const ports = formatSpan(span);
  const owner = formatProcesses(span);
  return owner ? `${ports} (${owner})` : ports;
}

export function findingsFor(row: PostureRow, exposure: NodeExposure, ctx: ExposureContext): Finding[] {
  const zone = preferredZone(row, ctx);
  const from = zone ? `from the ${zone.name} zone only` : "from the cidr that needs it only";
  return exposure.open
    .filter((span) => span.verdict === "unexplained")
    .map((span) => {
      const plural = span.from !== span.to;
      const subject = spanSubject(span);
      const owner = formatProcesses(span) || "this service";
      const sentence = `${subject} ${plural ? "are" : "is"} open to the internet and no rule allows ${plural ? "them" : "it"}.`;
      let hint: string;
      switch (row.coverage) {
        case "managed":
          hint = `The live table differs from what Lattice applied, so the compiled rules cannot vouch for ${plural ? "these ports" : "this port"}. Suggestion: allow ${owner} ${from}, then review and apply this node.`;
          break;
        case "legacy":
          hint = `The imported baseline has no rule for ${plural ? "these ports" : "this port"}. Suggestion: add ${owner} to a group ${from}, then adopt the baseline.`;
          break;
        case "observe_only":
          hint = `NetGuard observes this node and enforces nothing on it. Suggestion: add ${owner} to a group ${from}, then turn on management in the node's binding.`;
          break;
        default:
          hint = `This node has no binding, so nothing Lattice knows about confines it. Suggestion: bind the node, then allow ${owner} ${from}.`;
      }
      return {
        key: `${row.nodeId}:${span.protocol}:${span.from}-${span.to}`,
        nodeId: row.nodeId,
        nodeName: row.nodeName,
        span,
        sentence,
        hint,
        zoneId: zone?.id,
      };
    });
}

/** The rule a finding proposes, ready to drop into the group editor. */
export function draftRuleFor(finding: Finding): GuardRule {
  const owner = formatProcesses(finding.span);
  return {
    id: `draft-${finding.span.protocol}-${finding.span.from}-${finding.span.to}`,
    action: "allow",
    direction: "ingress",
    protocol: finding.span.protocol,
    ports: [{ from: finding.span.from, to: finding.span.to }],
    remote: finding.zoneId ? { kind: "zone", zone_id: finding.zoneId } : { kind: "any" },
    comment: `${owner || "listener"} on ${finding.nodeName}`,
  };
}

// ── ordering and counts ─────────────────────────────────────────────────────

export type ExposureSortKey = "attention" | "name" | "open" | "managed" | "drift" | "seen";

const managedRank: Record<ManagedBy["kind"], number> = { groups: 0, legacy: 1, none: 2 };
const driftRank: Record<PostureRow["driftState"], number> = { drift: 0, unknown: 1, in_sync: 2 };

function timeValue(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Default order: the nodes with unexplained open ports first, then drifted,
 * then the rest by name. A panel that answers "what is open" has to open on
 * the answer.
 */
export function compareExposure(
  a: { row: PostureRow; exposure: NodeExposure },
  b: { row: PostureRow; exposure: NodeExposure },
  key: ExposureSortKey,
): number {
  switch (key) {
    case "name":
      return a.row.nodeName.localeCompare(b.row.nodeName);
    case "open":
      return b.exposure.open.length - a.exposure.open.length;
    case "managed":
      return managedRank[a.exposure.managedBy.kind] - managedRank[b.exposure.managedBy.kind];
    case "drift":
      return driftRank[a.row.driftState] - driftRank[b.row.driftState];
    case "seen":
      // Oldest evidence first: the node nobody has heard from is the one to chase.
      return timeValue(b.row.collectedAt) - timeValue(a.row.collectedAt);
    default: {
      const unexplained = b.exposure.unexplained - a.exposure.unexplained;
      if (unexplained) return unexplained;
      const drift = driftRank[a.row.driftState] - driftRank[b.row.driftState];
      if (drift) return drift;
      return a.row.nodeName.localeCompare(b.row.nodeName);
    }
  }
}

/** The most recent snapshot time across the fleet, for the proof line. */
export function newestCollectedAt(rows: readonly PostureRow[]): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const row of rows) {
    if (!row.collectedAt) continue;
    const value = Date.parse(row.collectedAt);
    if (!Number.isNaN(value) && value > bestValue) {
      bestValue = value;
      best = row.collectedAt;
    }
  }
  return best;
}
