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
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

// ── reality / review (server D3a) ────────────────────────────────────────────
//
// A NetGuard binding says what a node's firewall SHOULD be. A reality snapshot
// is what the node reports it actually has. Until these two were reachable
// from the plugin, the UI could only ever show intent — an operator could read
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

/** One row of the fleet-wide list: enough to tell which node to open. */
export interface RealitySummary {
  node_id: string;
  snapshot_status: string;
  collected_at?: string;
  received_at?: string;
  stale_after?: string;
  managed_sha?: string;
  listener_count?: number;
  interface_count?: number;
  foreign_table_count?: number;
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

export interface ReviewResponse {
  review: {
    node: unknown;
    reality: RealityDetail;
    suggestions: GuardSuggestion[];
    drift_state: string;
    replan_input?: { node_id: string };
  };
}

/**
 * How a node's drift reads to a person.
 *
 * "unknown" is the honest answer whenever either side of the comparison is
 * missing — a node that has never reported, or a binding that has never been
 * applied. Calling that "in sync" would be the most dangerous label in the
 * panel: it is exactly the state where nobody knows.
 */
export function driftTone(state: string): "ok" | "warn" | "danger" | "muted" {
  if (state === "in_sync") return "ok";
  if (state === "drift_detected") return "danger";
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
