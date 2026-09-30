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
 *     from the internet. A baseline with no 22 rule closes SSH to knockers on
 *     the first apply.
 *   - A socket bound to a zone address (a tailscale or WireGuard IP). The
 *     compiler accepts a zone wholesale only when the binding trusts it
 *     (internal/netguard/compile.go, trusted zones first), and a rule reaches
 *     it only when its remote is "any" (no interface or source constraint) or
 *     that zone (its CIDRs or interface). An allow from the public zone is
 *     `iifname <public>` and does not.
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
  isPublicCidr,
  nodeRules,
  remoteScope,
  ruleCovers,
  ruleSentence,
  zoneIndex,
  type ExposureContext,
  type KnockGate,
  type Protocol,
  type Span,
} from "./exposure";
import type { GuardNodeReality, GuardRule } from "./netguardModel";
import type { ExposureRowView } from "./overview";

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

/** "22/tcp sshd", "51820/udp", "31001-31012/tcp sing-box". */
function portLabel(span: Span): string {
  const ports = span.from === span.to ? String(span.from) : `${span.from}-${span.to}`;
  return [`${ports}/${span.protocol}`, formatProcesses(span)].filter(Boolean).join(" ");
}

/** A rule the internet reaches the port through: no source constraint, a public cidr, or the public zone. */
function acceptsFromInternet(rule: GuardRule): boolean {
  const kind = rule.remote?.kind ?? "any";
  if (kind === "any" || kind === "") return true;
  if (kind === "cidr") return isPublicCidr(rule.remote?.cidr);
  return kind === "zone" && rule.remote?.zone_id === PUBLIC_ZONE;
}

/** A rule traffic arriving through zone `zoneId` meets: no constraint at all, or that zone. */
function acceptsFromZone(rule: GuardRule, zoneId: string): boolean {
  const kind = rule.remote?.kind ?? "any";
  return kind === "any" || kind === "" || (kind === "zone" && rule.remote?.zone_id === zoneId);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The ports the knock gate or a zone bind reaches today that the table built
 * from these rules and this binding would not accept on that path. One entry
 * per protocol and port; the first reason found stands.
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
  const found = new Map<string, { span: Span; reason: string }>();

  for (const listener of reality.listeners ?? []) {
    const protocol = (listener.protocol ?? "").trim().toLowerCase();
    const port = listener.port ?? 0;
    if ((protocol !== "tcp" && protocol !== "udp") || port < 1 || port > 65535) continue;
    const placement = bindPlacement(listener, zones, interfaces);
    if (placement.kind === "local") continue;
    const covering = rules.filter((rule) => ruleCovers(rule, protocol as Protocol, port));
    const scoped = [...new Set(covering.map((rule) => remoteScope(rule.remote, ctx).label))];

    let reason = "";
    if (knock && protocol === "tcp" && knock.ports.includes(port)) {
      if (covering.some(acceptsFromInternet)) continue;
      const still =
        placement.kind === "public" && trustedNames.length
          ? ` Only the trusted ${describeScopes(trustedNames)} ${plural(trustedNames.length, "zone still reaches", "zones still reach")} it.`
          : "";
      reason = scoped.length
        ? `Gated by the SSH knock table today. The new table accepts it only from ${describeScopes(scoped)}, so a knock from anywhere else no longer gets through.${still}`
        : `Gated by the SSH knock table today. No rule accepts it, so a knock no longer gets through.${still}`;
    } else if (placement.kind === "zone" && placement.zoneId) {
      const zoneId = placement.zoneId;
      if (trusted.has(zoneId) || covering.some((rule) => acceptsFromZone(rule, zoneId))) continue;
      const name = zones.get(zoneId)?.name || zoneId;
      reason = scoped.length
        ? `Bound to a ${name} address, reachable through that zone today. This node does not trust the ${name} zone, and the new table accepts the port only from ${describeScopes(scoped)}.`
        : `Bound to a ${name} address, reachable through that zone today. This node does not trust the ${name} zone and no rule accepts the port from it.`;
    } else {
      continue;
    }

    const key = `${protocol}/${port}`;
    const existing = found.get(key);
    const process = (listener.process ?? "").trim();
    if (existing) {
      if (process && !existing.span.processes.includes(process)) existing.span.processes.push(process);
      continue;
    }
    found.set(key, { span: { protocol: protocol as Protocol, from: port, to: port, processes: process ? [process] : [] }, reason });
  }

  return [...found.values()]
    .sort((left, right) => left.span.protocol.localeCompare(right.span.protocol) || left.span.from - right.span.from)
    .map(({ span, reason }) => ({ port: portLabel(span), reason }));
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
