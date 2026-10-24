export interface PortRange { from: number; to: number }
export interface Remote { kind: string; node_id?: string; cidr?: string; domain?: string; group_id?: string; zone_id?: string }
export interface GuardRule {
  id: string;
  comment?: string;
  action: "allow" | "deny";
  direction: "ingress" | "egress";
  protocol: "tcp" | "udp" | "icmp" | "icmpv6" | "any";
  ports: PortRange[];
  remote: Remote;
  log?: boolean;
  disabled?: boolean;
}
export interface SecurityGroup {
  id: string;
  name: string;
  description?: string;
  rules: GuardRule[];
  version: number;
  source?: string;
  node_id?: string;
}
export interface GuardZone {
  id: string;
  name: string;
  builtin?: boolean;
  interfaces?: string[];
  cidrs?: string[];
  description?: string;
}
export interface NodeBinding {
  node_id: string;
  group_ids: string[];
  overrides?: GuardRule[];
  zone_ids?: string[];
  managed: boolean;
  version: number;
  last_plan_sha?: string;
  last_applied_at?: string;
  last_error?: string;
  applied_table_sha?: string;
}
export interface GuardNode {
  node_id: string;
  node_name?: string;
  source: "stored" | "legacy";
  binding: NodeBinding;
  groups: SecurityGroup[];
  zones: GuardZone[];
}
export interface Overview { groups: SecurityGroup[]; zones: GuardZone[]; nodes: GuardNode[] }

export function parseRanges(value: string): PortRange[] {
  const ranges: PortRange[] = [];
  const seen = new Set<string>();
  for (const token of value.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const match = part.match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!match) throw new Error(`Invalid port range: ${part}`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to > 65535 || from > to) throw new Error(`Port range is outside 1-65535: ${part}`);
    const key = `${from}-${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      ranges.push({ from, to });
    }
  }
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function formatRanges(ranges: PortRange[] | undefined): string {
  return (ranges ?? []).map((range) => range.from === range.to ? String(range.from) : `${range.from}-${range.to}`).join(", ");
}

export function remoteValue(remote: Remote): string {
  return remote.cidr || remote.node_id || remote.group_id || remote.zone_id || remote.domain || "";
}

/**
 * Remote kinds the guard compiler lowers. It refuses group remotes (they must
 * be expanded to node refs first, which has not shipped) and domain remotes (a
 * name is not a trustworthy source identity) on every plan, so the editor
 * does not offer them (design 32 D7).
 */
export const GUARD_REMOTE_KINDS = ["any", "cidr", "node", "zone"] as const;

export interface RemoteKindOption {
  value: string;
  label: string;
  disabled: boolean;
}

/**
 * The remote kinds a rule's select offers. A rule loaded with a kind the
 * compiler refuses keeps that kind visible, disabled and labelled, so the
 * select does not go blank and the operator can see what to replace.
 */
export function remoteKindOptions(current: string): RemoteKindOption[] {
  const options: RemoteKindOption[] = GUARD_REMOTE_KINDS.map((kind) => ({ value: kind, label: kind, disabled: false }));
  if (current && !(GUARD_REMOTE_KINDS as readonly string[]).includes(current)) {
    options.push({ value: current, label: `${current} (not compiled)`, disabled: true });
  }
  return options;
}

/** Why a remote kind cannot be saved, or undefined when the compiler lowers it. */
export function unsupportedRemoteReason(kind: string): string | undefined {
  if ((GUARD_REMOTE_KINDS as readonly string[]).includes(kind)) return undefined;
  if (kind === "group") return "group remotes are not compiled yet. Change the remote to the member nodes or their CIDRs, or remove the rule.";
  if (kind === "domain") return "domain remotes are not accepted inbound, since a name is not a trustworthy source. Change the remote to a CIDR, or remove the rule.";
  return `remote kind "${kind}" is not supported. Change the remote, or remove the rule.`;
}

/**
 * The guard table filters inbound traffic only: the compiler refuses an
 * egress rule ("egress stays with netpolicy"), so the editor offers ingress,
 * and a loaded egress rule keeps its direction visible, disabled and marked.
 */
export function directionOptions(current: string): RemoteKindOption[] {
  const options: RemoteKindOption[] = [{ value: "ingress", label: "ingress", disabled: false }];
  if (current && current !== "ingress") options.push({ value: current, label: `${current} (not compiled)`, disabled: true });
  return options;
}

/** Why a rule cannot be saved, or undefined when the compiler lowers it. */
export function unsupportedRuleReason(rule: Pick<GuardRule, "direction" | "remote">): string | undefined {
  if (rule.direction !== "ingress") {
    return "the guard table filters inbound traffic only, and outbound rules belong to the outbound policy. Change the direction to ingress, or remove the rule.";
  }
  return unsupportedRemoteReason(rule.remote?.kind ?? "any");
}

export function buildRemote(kind: string, value: string): Remote {
  const remote: Remote = { kind };
  const clean = value.trim();
  if (kind === "cidr") remote.cidr = clean;
  if (kind === "node") remote.node_id = clean;
  if (kind === "group") remote.group_id = clean;
  if (kind === "zone") remote.zone_id = clean;
  if (kind === "domain") remote.domain = clean;
  return remote;
}

export function safeErrorMessage(value: unknown, fallback = "Request failed"): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  // A DOMException is not an instanceof Error in Chrome, and postMessage throws
  // one. Without this branch a structured-clone failure surfaced as the generic
  // fallback, which is how a broken write path looked like a server refusal.
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = String((value as { message: unknown }).message).trim();
    if (message) return message;
  }
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

/** A message as a sentence, so two of them can follow each other. */
export function endSentence(value: string): string {
  const clean = value.trim();
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * Strip anything that cannot cross the bridge.
 *
 * The host is reached through postMessage, which structured-clones its
 * argument, and a Vue reactive proxy is not cloneable: passing one throws a
 * DataCloneError before the call is ever sent. Every payload assembled from a
 * reactive form hits this, so the conversion belongs here at the boundary
 * rather than at each call site where the next one added would forget it.
 *
 * A JSON round trip is the right conversion and not a lazy one: the wire is
 * JSON, so anything it would drop could not have been transmitted anyway.
 */
/**
 * The delete question, with its blast radius in words. The confirm dialog
 * covers the table, so the "used by" count the operator just read is off
 * screen at the moment they decide; the sentence carries it.
 */
export function deleteQuestion(kind: "group" | "zone", label: string, usedBy: number): string {
  const noun = kind === "group" ? "security group" : "trusted zone";
  const lead = `This removes the ${noun} ${label} from NetGuard.`;
  if (usedBy === 0) return `${lead} No node references it.`;
  if (usedBy === 1) return `${lead} 1 node still references it; it keeps its current rules until it is planned again.`;
  return `${lead} ${usedBy} nodes still reference it; each keeps its current rules until it is planned again.`;
}

export function toWire<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── reality / review (server D3a) ────────────────────────────────────────────
//
// A NetGuard binding says what a node's firewall SHOULD be. A reality snapshot
// is what the node reports it actually has. Until these two were reachable
// from the plugin, the UI could only ever show intent. An operator could read
// their own rules back and learn nothing about whether the machine agrees.

export interface GuardListener {
  protocol?: string;
  address?: string;
  port?: number;
  process?: string;
  pid?: number;
}

export interface GuardInterface {
  name?: string;
  addresses?: string[];
  up?: boolean;
}

export interface GuardNodeReality {
  node_id: string;
  listeners?: GuardListener[];
  interfaces?: GuardInterface[];
  managed_sha?: string;
  foreign_tables?: string[];
  nft_version?: string;
  collected_at: string;
}

/**
 * One row of the fleet-wide list.
 *
 * This carries drift and binding state as well as freshness, so a fleet-wide
 * posture view is one request rather than one request per node. Everything
 * optional is genuinely absent for a node that has never reported: a missing
 * count is not zero, and rendering it as zero would claim the node has no
 * listeners when the truth is that nobody has looked.
 */
export interface RealitySummary {
  node_id: string;
  node_name?: string;
  snapshot_status: string;
  drift_state?: string;
  managed?: boolean;
  has_binding?: boolean;
  collected_at?: string;
  received_at?: string;
  stale_after?: string;
  managed_sha?: string;
  applied_table_sha?: string;
  last_applied_at?: string;
  last_error?: string;
  listener_count?: number;
  interface_count?: number;
  foreign_table_count?: number;
}

/** One lint result from the plan or review path. */
export interface LintFinding {
  code: string;
  severity: string;
  message: string;
}

export interface RealityListResponse {
  nodes: RealitySummary[];
  next_cursor?: string;
}

export interface RealityDetail {
  node_id: string;
  snapshot_status: string;
  reality: GuardNodeReality | null;
  received_at?: string | null;
  stale_after?: string | null;
  /** True when the report lists the inet lattice_knock table: SSH Guard's gate is on the node. */
  knock_gate?: boolean;
  /** The tcp ports that gate covers; absent when the table is there but its scope is not known. */
  knock_gated_ports?: number[];
}

/** `reality` called with a node_id answers with the detail under `node`. */
export interface RealityDetailResponse {
  node: RealityDetail;
}

export interface GuardSuggestion {
  id: string;
  code: string;
  severity: string;
  title: string;
  detail: string;
  zone_id?: string;
  interface?: string;
  protocol?: string;
  port?: number;
  address?: string;
  process?: string;
}

export interface Review {
  node: GuardNode;
  reality: RealityDetail;
  suggestions: GuardSuggestion[];
  drift_state: string;
  replan_input?: { node_id: string };
  /** What Lint says about the plan this node's intent compiles to right now. */
  findings?: LintFinding[];
  /** The nft text this intent renders to. Empty when compile_error is set. */
  ruleset?: string;
  /** Why ruleset is empty. Reality is still rendered when this is set. */
  compile_error?: string;
}

export interface ReviewResponse {
  review: Review;
}

/**
 * How a node's drift reads to a person.
 *
 * "unknown" is the honest answer whenever either side of the comparison is
 * missing: a node that has never reported, or a binding that has never been
 * applied. Calling that "in sync" would be the most dangerous label in the
 * panel: it is exactly the state where nobody knows.
 */
export function driftTone(state: string): "ok" | "warn" | "danger" | "muted" {
  if (state === "in_sync") return "ok";
  // The server's constant is "drift". This read "drift_detected" and so fell
  // through to the neutral fallback: the one state that must shout was the one
  // rendered quietly.
  if (state === "drift") return "danger";
  if (state === "unknown") return "muted";
  return "warn";
}

/** Snapshot freshness, same three states the server computes. */
export function snapshotTone(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "fresh") return "ok";
  if (status === "stale") return "warn";
  if (status === "unknown") return "muted";
  return "warn";
}

export function severityTone(severity: string): "ok" | "warn" | "danger" | "muted" {
  const normalized = severity.toLowerCase();
  if (normalized === "high" || normalized === "critical") return "danger";
  if (normalized === "medium" || normalized === "warning") return "warn";
  if (normalized === "low" || normalized === "info") return "muted";
  return "warn";
}

/**
 * A listener is "unexplained" when nothing in the compiled intent would let it
 * be reached. The server's suggestions already carry that judgement; this only
 * indexes them by port so the listener table can point at the right one
 * instead of making the operator match numbers by eye.
 */
export function suggestionsByPort(suggestions: readonly GuardSuggestion[]): Map<number, GuardSuggestion[]> {
  const index = new Map<number, GuardSuggestion[]>();
  for (const suggestion of suggestions) {
    if (typeof suggestion.port !== "number" || suggestion.port <= 0) continue;
    const existing = index.get(suggestion.port);
    if (existing) existing.push(suggestion);
    else index.set(suggestion.port, [suggestion]);
  }
  return index;
}

/** Sort: unexplained listeners first, then by port, so the panel opens on what matters. */
export function orderListeners(
  listeners: readonly GuardListener[],
  flagged: ReadonlySet<number>,
): GuardListener[] {
  return [...listeners].sort((a, b) => {
    const aFlagged = flagged.has(a.port ?? -1) ? 0 : 1;
    const bFlagged = flagged.has(b.port ?? -1) ? 0 : 1;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    return (a.port ?? 0) - (b.port ?? 0);
  });
}
