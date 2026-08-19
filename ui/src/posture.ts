/**
 * Fleet posture: intent joined to reality, per node.
 *
 * The two halves of NetGuard live in different requests. `overview` says what
 * an operator declared; `reality` says what each machine reports it actually
 * has. Neither is useful alone, and the panel that shows only one of them is
 * how a fleet ends up looking green while a third of it has never reported.
 *
 * Everything here is pure so the classification an operator's decisions rest
 * on can be tested without a DOM.
 */

import type { GuardNode, RealitySummary } from "./netguardModel";

/** How far Lattice's authority reaches over a node. */
export type Coverage = "managed" | "observe_only" | "legacy" | "unbound";

/** Whether the node's report is recent enough to believe. */
export type SnapshotStatus = "fresh" | "stale" | "unknown";

/** Whether the live managed table still matches what Lattice installed. */
export type DriftState = "in_sync" | "drift" | "unknown";

export interface PostureRow {
  nodeId: string;
  nodeName: string;
  coverage: Coverage;
  snapshotStatus: SnapshotStatus;
  driftState: DriftState;
  source?: string;
  listenerCount?: number;
  interfaceCount?: number;
  foreignTableCount?: number;
  managedSha?: string;
  appliedTableSha?: string;
  collectedAt?: string;
  lastAppliedAt?: string;
  lastError?: string;
  groupIds: string[];
  zoneIds: string[];
  /** The intent record, when this node has one. */
  intent?: GuardNode;
}

export interface PostureCounts {
  total: number;
  managed: number;
  observeOnly: number;
  legacy: number;
  unbound: number;
  drifted: number;
  inSync: number;
  driftUnknown: number;
  neverReported: number;
  stale: number;
  fresh: number;
  withForeignTables: number;
  withApplyError: number;
}

export type PostureFilter =
  | "all"
  | "drifted"
  | "never_reported"
  | "stale"
  | "foreign_tables"
  | "unmanaged"
  | "apply_error";

export type SortKey =
  | "attention"
  | "name"
  | "coverage"
  | "snapshot"
  | "drift"
  | "listeners"
  | "foreign_tables"
  | "last_applied";

export type SortDirection = "asc" | "desc";

function normalizeSnapshot(value: string | undefined): SnapshotStatus {
  return value === "fresh" || value === "stale" ? value : "unknown";
}

function normalizeDrift(value: string | undefined): DriftState {
  return value === "in_sync" || value === "drift" ? value : "unknown";
}

function coverageOf(intent: GuardNode | undefined): Coverage {
  if (!intent) return "unbound";
  if (intent.source === "legacy") return "legacy";
  return intent.binding?.managed ? "managed" : "observe_only";
}

/**
 * Join the two halves.
 *
 * The reality list is the authoritative node roster: it carries every node the
 * caller may see, including the ones that have never reported and the ones no
 * binding covers. Intent is layered on top. A node that somehow appears only in
 * intent is still emitted rather than dropped, because silently losing a node
 * from a firewall inventory is the worst failure this function could have.
 */
export function joinPosture(
  nodes: readonly GuardNode[],
  reality: readonly RealitySummary[],
): PostureRow[] {
  const intentById = new Map<string, GuardNode>();
  for (const node of nodes) {
    if (node?.node_id) intentById.set(node.node_id, node);
  }

  const rows: PostureRow[] = [];
  const seen = new Set<string>();

  for (const row of reality) {
    if (!row?.node_id) continue;
    seen.add(row.node_id);
    const intent = intentById.get(row.node_id);
    rows.push({
      nodeId: row.node_id,
      nodeName: row.node_name || intent?.node_name || row.node_id,
      coverage: coverageOf(intent),
      snapshotStatus: normalizeSnapshot(row.snapshot_status),
      driftState: normalizeDrift(row.drift_state),
      source: intent?.source,
      listenerCount: row.listener_count,
      interfaceCount: row.interface_count,
      foreignTableCount: row.foreign_table_count,
      managedSha: row.managed_sha,
      appliedTableSha: row.applied_table_sha || intent?.binding?.applied_table_sha,
      collectedAt: row.collected_at,
      lastAppliedAt: row.last_applied_at || intent?.binding?.last_applied_at,
      lastError: row.last_error || intent?.binding?.last_error,
      groupIds: intent?.binding?.group_ids ?? [],
      zoneIds: intent?.binding?.zone_ids ?? [],
      intent,
    });
  }

  for (const node of nodes) {
    if (!node?.node_id || seen.has(node.node_id)) continue;
    rows.push({
      nodeId: node.node_id,
      nodeName: node.node_name || node.node_id,
      coverage: coverageOf(node),
      snapshotStatus: "unknown",
      driftState: "unknown",
      source: node.source,
      appliedTableSha: node.binding?.applied_table_sha,
      lastAppliedAt: node.binding?.last_applied_at,
      lastError: node.binding?.last_error,
      groupIds: node.binding?.group_ids ?? [],
      zoneIds: node.binding?.zone_ids ?? [],
      intent: node,
    });
  }

  return rows;
}

export function countPosture(rows: readonly PostureRow[]): PostureCounts {
  const counts: PostureCounts = {
    total: rows.length,
    managed: 0,
    observeOnly: 0,
    legacy: 0,
    unbound: 0,
    drifted: 0,
    inSync: 0,
    driftUnknown: 0,
    neverReported: 0,
    stale: 0,
    fresh: 0,
    withForeignTables: 0,
    withApplyError: 0,
  };
  for (const row of rows) {
    if (row.coverage === "managed") counts.managed++;
    else if (row.coverage === "observe_only") counts.observeOnly++;
    else if (row.coverage === "legacy") counts.legacy++;
    else counts.unbound++;

    if (row.driftState === "drift") counts.drifted++;
    else if (row.driftState === "in_sync") counts.inSync++;
    else counts.driftUnknown++;

    if (row.snapshotStatus === "fresh") counts.fresh++;
    else if (row.snapshotStatus === "stale") counts.stale++;
    else counts.neverReported++;

    if ((row.foreignTableCount ?? 0) > 0) counts.withForeignTables++;
    if (row.lastError) counts.withApplyError++;
  }
  return counts;
}

export function matchesFilter(row: PostureRow, filter: PostureFilter): boolean {
  switch (filter) {
    case "drifted":
      return row.driftState === "drift";
    case "never_reported":
      return row.snapshotStatus === "unknown";
    case "stale":
      return row.snapshotStatus === "stale";
    case "foreign_tables":
      return (row.foreignTableCount ?? 0) > 0;
    case "unmanaged":
      return row.coverage !== "managed";
    case "apply_error":
      return Boolean(row.lastError);
    default:
      return true;
  }
}

export function searchPosture(rows: readonly PostureRow[], query: string): PostureRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.nodeId.toLowerCase().includes(needle) ||
      row.nodeName.toLowerCase().includes(needle) ||
      row.groupIds.some((id) => id.toLowerCase().includes(needle)) ||
      row.zoneIds.some((id) => id.toLowerCase().includes(needle)),
  );
}

/**
 * How loudly a row should ask for attention. Higher sorts first under the
 * default ordering, so an operator opening the panel lands on the nodes that
 * are wrong rather than on whichever node sorts first alphabetically.
 *
 * Drift outranks everything: it is the only state that means a machine is
 * enforcing rules nobody in Lattice wrote.
 */
export function attentionRank(row: PostureRow): number {
  if (row.driftState === "drift") return 5;
  if (row.lastError) return 4;
  if (row.snapshotStatus === "stale") return 3;
  if (row.snapshotStatus === "unknown") return 2;
  if ((row.foreignTableCount ?? 0) > 0) return 1;
  return 0;
}

const coverageRank: Record<Coverage, number> = {
  managed: 0,
  observe_only: 1,
  legacy: 2,
  unbound: 3,
};

const snapshotRank: Record<SnapshotStatus, number> = { fresh: 0, stale: 1, unknown: 2 };
const driftRank: Record<DriftState, number> = { in_sync: 0, unknown: 1, drift: 2 };

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareBy(key: SortKey, a: PostureRow, b: PostureRow): number {
  switch (key) {
    case "name":
      return a.nodeName.localeCompare(b.nodeName);
    case "coverage":
      return coverageRank[a.coverage] - coverageRank[b.coverage];
    case "snapshot":
      return snapshotRank[a.snapshotStatus] - snapshotRank[b.snapshotStatus];
    case "drift":
      return driftRank[a.driftState] - driftRank[b.driftState];
    case "listeners":
      return (a.listenerCount ?? -1) - (b.listenerCount ?? -1);
    case "foreign_tables":
      return (a.foreignTableCount ?? -1) - (b.foreignTableCount ?? -1);
    case "last_applied":
      return timeValue(a.lastAppliedAt) - timeValue(b.lastAppliedAt);
    default:
      return attentionRank(b) - attentionRank(a);
  }
}

export function sortPosture(
  rows: readonly PostureRow[],
  key: SortKey,
  direction: SortDirection,
): PostureRow[] {
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const primary = compareBy(key, a, b) * factor;
    if (primary !== 0) return primary;
    // Node id is the tie-break everywhere, so a re-sort never shuffles equal
    // rows under the operator.
    return a.nodeId.localeCompare(b.nodeId);
  });
}

/** The default ordering already puts problems on top, so it opens descending. */
export function defaultDirectionFor(key: SortKey): SortDirection {
  return key === "attention" ? "asc" : "asc";
}

export function coverageLabel(coverage: Coverage): string {
  if (coverage === "managed") return "managed";
  if (coverage === "observe_only") return "observe only";
  if (coverage === "legacy") return "legacy baseline";
  return "no binding";
}

export function snapshotLabel(status: SnapshotStatus): string {
  if (status === "fresh") return "reporting";
  if (status === "stale") return "stale";
  return "never reported";
}

export function driftLabel(state: DriftState): string {
  if (state === "in_sync") return "in sync";
  if (state === "drift") return "drifted";
  return "unknown";
}

/**
 * Why a node's drift is unknown, in the operator's terms.
 *
 * "unknown" has two very different causes and conflating them wastes an
 * operator's time: one is fixed by upgrading an agent, the other by applying a
 * plan. Neither is an error, and neither is in sync.
 */
export function driftUnknownReason(row: PostureRow): string {
  if (row.snapshotStatus === "unknown") {
    return "this node has never reported its firewall, so there is nothing to compare against";
  }
  if (!row.appliedTableSha) {
    return "Lattice has never applied a ruleset to this node, so there is no anchor to compare against";
  }
  if (!row.managedSha) {
    return "the node reported, but its managed table is absent or unreadable, so no hash could be compared";
  }
  return "one side of the comparison is missing";
}

export type Tone = "ok" | "warn" | "danger" | "muted";

export function coverageTone(coverage: Coverage): Tone {
  if (coverage === "managed") return "ok";
  if (coverage === "unbound") return "muted";
  return "warn";
}

export function snapshotToneFor(status: SnapshotStatus): Tone {
  if (status === "fresh") return "ok";
  if (status === "stale") return "warn";
  return "muted";
}

export function driftToneFor(state: DriftState): Tone {
  if (state === "in_sync") return "ok";
  if (state === "drift") return "danger";
  return "muted";
}
