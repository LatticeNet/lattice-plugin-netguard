/**
 * What adopting a legacy baseline leads to, before the operator agrees to it.
 *
 * Adopting (server `handleNetGuardAdopt`) saves the node's imported baseline
 * as a stored security group, binds it to the node and turns management on.
 * Nothing reaches the node then: the next approved apply installs the
 * compiled table, whose chain policy is drop, with established replies and
 * loopback accepted (lattice-server internal/network/nft.go). So the preview
 * is the baseline's rules, the zones the node trusts, and the ports open now
 * that no rule accepts, which that apply would close.
 *
 * Some ports are reachable today by a path the new table does not keep, and
 * they are not "open with no rule" either, so they need their own list:
 *
 *   - A tcp port the SSH knock table gates. That table is its own base chain
 *     on the input hook (lattice-server internal/sshguard/artifacts.go,
 *     priority filter -10, policy accept), and lattice_guard is another
 *     (priority 0, policy drop). An accept in one base chain ends only that
 *     chain; the packet still meets the next one, so a knocked SYN reaches
 *     lattice_guard's `counter drop` unless a rule there accepts the port
 *     from every address: remote "any", the public zone (`iifname <public>`),
 *     or a /0 prefix. Any narrower cidr, public or private, admits only
 *     itself. A baseline with no 22 rule closes SSH to knockers on the first
 *     apply.
 *   - A socket bound to a zone address (a tailscale or WireGuard IP). The
 *     compiler accepts a zone wholesale only when the binding trusts it
 *     (internal/netguard/compile.go, trusted zones first), and a rule reaches
 *     it only when its remote is "any" or that zone. An allow from the
 *     public zone is `iifname <public>` and does not.
 *
 * Every source match is per address family, so each socket is judged for
 * its own: `ip saddr 0.0.0.0/0` is IPv4 only, a WireGuard-zone allow with
 * ports takes the fast path `ip saddr @wg_peers4` (IPv4 peers only, nft.go),
 * a zone rule with CIDRs matches those CIDRs and not the zone's interfaces
 * (compile.go ruleSource), and a trusted zone is accepted by interface
 * (both families) and by its CIDRs.
 *
 * The server does not compile a baseline before it is adopted (the review of
 * a legacy node carries a compile error, not a ruleset), so the exact nft
 * text is not available here; Review and apply shows it, with the diff,
 * before any approval exists.
 */
import {
  LOOPBACK_ZONE,
  PUBLIC_ZONE,
  bindPlacement,
  describeScopes,
  formatProcesses,
  indexInterfaces,
  nodeRules,
  parseAddress,
  parsePrefix,
  remoteScope,
  ruleCovers,
  ruleSentence,
  zoneIndex,
  type ExposureContext,
  type KnockGate,
  type Protocol,
  type Span,
} from "./exposure";
import type { GuardNodeReality, GuardRule, GuardZone } from "./netguardModel";
import type { ExposureRowView } from "./overview";

/** The builtin zone whose ported allows render as `ip saddr @wg_peers4`. */
const WIREGUARD_ZONE = "wireguard";

/** A port reachable today by a path the new table does not accept. */
export interface CutOff {
  /** "22/tcp sshd". */
  port: string;
  /** Which path reaches it today and why the new table does not keep it. */
  reason: string;
}

export interface AdoptPreview {
  /** The baseline group(s) the node's rules come from. */
  groupNames: string[];
  rules: { key: string; sentence: string; disabled: boolean; comment?: string }[];
  /** Zones the node trusts before any rule runs. */
  zones: string[];
  /** Whether the dropped list can be believed: the node's snapshot is fresh and was read. */
  evidence: "fresh" | "stale" | "none" | "reading";
  /** Open to the internet now, accepted by no rule, so the first apply closes them. */
  dropped: string[];
  /** Open now with a bind the snapshot does not report; the apply may close them. */
  uncertain: string[];
  /** Reachable today through the knock gate or a zone bind, and not accepted by the new table. */
  cut: CutOff[];
}

/** What the node's snapshot and knock gate say, for the ports that reach it by another path. */
export interface AdoptFacts {
  reality?: GuardNodeReality;
  knock?: KnockGate;
}

type Family = 4 | 6;

/** "22/tcp sshd", "51820/udp", "31001-31012/tcp sing-box". */
function portLabel(span: Span): string {
  const ports = span.from === span.to ? String(span.from) : `${span.from}-${span.to}`;
  return [`${ports}/${span.protocol}`, formatProcesses(span)].filter(Boolean).join(" ");
}

/**
 * A rule that accepts this socket's family from every address: no source
 * constraint, the public zone (an interface match), or a /0 prefix of the
 * same family. 203.0.113.7/32 is a public address and still admits only
 * itself.
 */
function acceptsFromEverywhere(rule: GuardRule, family: Family | undefined): boolean {
  const kind = rule.remote?.kind ?? "any";
  if (kind === "any" || kind === "") return true;
  if (kind === "zone") return rule.remote?.zone_id === PUBLIC_ZONE;
  if (kind !== "cidr") return false;
  const prefix = parsePrefix(rule.remote?.cidr);
  return prefix?.bits === 0 && (family === undefined || prefix.addr.v === family);
}

function cidrsReach(cidrs: readonly string[] | undefined, family: Family | undefined): boolean {
  return (cidrs ?? []).some((cidr) => {
    const prefix = parsePrefix(cidr);
    return prefix !== undefined && (family === undefined || prefix.addr.v === family);
  });
}

/** A trusted zone is accepted by each interface (both families) and by its CIDRs. */
function trustedZoneReaches(zone: GuardZone | undefined, family: Family | undefined): boolean {
  if (!zone) return false;
  return (zone.interfaces ?? []).length > 0 || cidrsReach(zone.cidrs, family);
}

/**
 * Whether a covering rule whose remote is zone `zone` reaches a socket of this
 * family. A WireGuard-zone allow with ports is the fast path, `ip saddr
 * @wg_peers4`: IPv4 peers only. Otherwise a zone with CIDRs is matched by
 * those CIDRs alone, and a zone without them by its interface.
 */
function zoneRuleReaches(rule: GuardRule, zone: GuardZone | undefined, family: Family | undefined): boolean {
  if (!zone) return false;
  const fastPath = zone.id === WIREGUARD_ZONE && (rule.protocol === "tcp" || rule.protocol === "udp") && (rule.ports ?? []).length > 0;
  if (fastPath) return family !== 6;
  if ((zone.cidrs ?? []).length) return cidrsReach(zone.cidrs, family);
  return (zone.interfaces ?? []).length > 0;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

interface CutEntry {
  protocol: Protocol;
  port: number;
  processes: Set<string>;
  reason: string;
}

/**
 * The ports the knock gate or a zone bind reaches today that the table built
 * from these rules and this binding would not accept on that path, each
 * socket judged for its own address family. One entry per protocol and
 * port; the first reason found stands.
 */
export function cutOffs(view: ExposureRowView, ctx: ExposureContext, facts: AdoptFacts): CutOff[] {
  const { reality, knock } = facts;
  if (!reality) return [];
  const row = view.row;
  const zones = zoneIndex(ctx.zones, row.intent?.zones);
  const interfaces = indexInterfaces(reality.interfaces);
  const rules = nodeRules(row, ctx);
  const trusted = new Set(row.intent?.binding?.zone_ids ?? []);
  const trustedNames = [...trusted].filter((id) => id !== LOOPBACK_ZONE && id !== PUBLIC_ZONE).map((id) => zones.get(id)?.name || id);
  const found = new Map<string, CutEntry>();

  for (const listener of reality.listeners ?? []) {
    const protocol = (listener.protocol ?? "").trim().toLowerCase();
    const port = listener.port ?? 0;
    if ((protocol !== "tcp" && protocol !== "udp") || port < 1 || port > 65535) continue;
    const placement = bindPlacement(listener, zones, interfaces);
    if (placement.kind === "local") continue;
    const family = parseAddress(listener.address)?.v;
    const covering = rules.filter((rule) => ruleCovers(rule, protocol as Protocol, port));
    const scoped = [...new Set(covering.map((rule) => remoteScope(rule.remote, ctx).label))];

    let reason = "";
    if (knock && protocol === "tcp" && knock.ports.includes(port)) {
      if (covering.some((rule) => acceptsFromEverywhere(rule, family))) continue;
      const still =
        placement.kind === "public" && trustedNames.length
          ? ` Only the trusted ${describeScopes(trustedNames)} ${plural(trustedNames.length, "zone still reaches", "zones still reach")} it.`
          : "";
      reason = scoped.length
        ? `Gated by the SSH knock table today. The new table accepts it only from ${describeScopes(scoped)}, so a knock from anywhere else no longer gets through.${still}`
        : `Gated by the SSH knock table today. No rule accepts it, so a knock no longer gets through.${still}`;
    } else if (placement.kind === "zone" && placement.zoneId) {
      const zoneId = placement.zoneId;
      const zone = zones.get(zoneId);
      const name = zone?.name || zoneId;
      const sameZone = covering.filter((rule) => rule.remote?.kind === "zone" && rule.remote.zone_id === zoneId);
      const anywhere = covering.some((rule) => (rule.remote?.kind ?? "any") === "any" || rule.remote?.kind === "");
      if (anywhere || (trusted.has(zoneId) && trustedZoneReaches(zone, family)) || sameZone.some((rule) => zoneRuleReaches(rule, zone, family))) continue;
      if (family && (trusted.has(zoneId) || sameZone.length)) {
        // The zone is accepted, but only for the other address family.
        reason = `Bound to an IPv${family} ${name} address, reachable through that zone today. The new table accepts the ${name} zone for IPv${family === 6 ? 4 : 6} sources only, so traffic to this address is dropped.`;
      } else {
        reason = scoped.length
          ? `Bound to a ${name} address, reachable through that zone today. This node does not trust the ${name} zone, and the new table accepts the port only from ${describeScopes(scoped)}.`
          : `Bound to a ${name} address, reachable through that zone today. This node does not trust the ${name} zone and no rule accepts the port from it.`;
      }
    } else {
      continue;
    }

    const key = `${protocol}/${port}`;
    const existing = found.get(key);
    const process = (listener.process ?? "").trim();
    if (existing) {
      if (process) existing.processes.add(process);
      continue;
    }
    found.set(key, { protocol: protocol as Protocol, port, processes: new Set(process ? [process] : []), reason });
  }

  return [...found.values()]
    .sort((left, right) => left.protocol.localeCompare(right.protocol) || left.port - right.port)
    .map((entry) => ({ port: portLabel({ protocol: entry.protocol, from: entry.port, to: entry.port, processes: [...entry.processes] }), reason: entry.reason }));
}

export function adoptPreview(view: ExposureRowView, ctx: ExposureContext, facts: AdoptFacts = {}): AdoptPreview {
  const intent = view.row.intent;
  const groups = intent?.groups ?? [];
  const rules = groups.flatMap((group) =>
    (group.rules ?? []).map((rule) => ({
      key: `${group.id}/${rule.id}`,
      sentence: ruleSentence(rule, ctx),
      disabled: Boolean(rule.disabled),
      comment: rule.comment,
    })),
  );
  const zoneIds = intent?.binding?.zone_ids ?? [];
  const zones = (intent?.zones?.length ? intent.zones : ctx.zones.filter((zone) => zoneIds.includes(zone.id))).map((zone) => zone.name || zone.id);

  const evidence: AdoptPreview["evidence"] =
    view.row.snapshotStatus === "unknown"
      ? "none"
      : view.exposure.evidence === "stale" || view.row.snapshotStatus === "stale"
        ? "stale"
        : view.detail === "loaded"
          ? "fresh"
          : "reading";
  const fresh = evidence === "fresh";
  return {
    groupNames: groups.map((group) => group.name || group.id),
    rules,
    zones,
    evidence,
    dropped: fresh ? view.exposure.open.filter((span) => span.verdict === "unexplained").map(portLabel) : [],
    uncertain: fresh ? view.exposure.open.filter((span) => span.verdict === "unknown").map(portLabel) : [],
    cut: fresh ? cutOffs(view, ctx, facts) : [],
  };
}
