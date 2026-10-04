import type { StateTone } from "@latticenet/plugin-bridge/chassis";

import type { ConfinedSpan, OpenSpan } from "./exposure";
import { KNOCK_SCOPE, describeScopes, formatSpan, formatSpans } from "./exposure";
import { hasFreshEvidence, type ExposureRowView } from "./overview";
import { driftUnknownReason } from "./posture";
import { stampUtc } from "./time";

/**
 * What one row of the Nodes table says, before it is drawn. DOM-free, so the
 * tests read the verdicts without a renderer.
 *
 * The Status column is the row's verdict at its left edge: the one answer to
 * "does this node need me", picked from facts the row already had in three
 * places (the drift pill, the coverage note, the red marks inside the port
 * list). The order is the attention order: a state that needs a hand
 * (drift, a failed apply, ports no rule allows) wins over one that only
 * limits what can be known (stale, never reported, not read), which wins over
 * the quiet states. Error tone is exactly the Needs attention filter
 * (overview.ts needsAttention), so the dots and the filter never disagree.
 */

export type NodeStatusKey =
  | "intent-only"
  | "reality-unread"
  | "drift"
  | "apply-failed"
  | "unexplained"
  | "never-reported"
  | "stale"
  | "snapshot-unread"
  | "reading"
  | "not-judged"
  | "enforced"
  | "never-applied"
  | "no-managed-table"
  | "unverified"
  | "not-enforced"
  | "no-binding";

export interface NodeStatus {
  key: NodeStatusKey;
  tone: StateTone;
  label: string;
  /** The evidence behind the word, for the cell's title. */
  title: string;
}

function sentence(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * `realityRead` is false when the session may read reality but the read
 * failed: a row with no snapshot then says it was not read, not that the node
 * never reported, which nobody checked.
 */
export function nodeStatus(view: ExposureRowView, canSeeReality: boolean, realityRead = true): NodeStatus {
  const { row, exposure } = view;
  // The three error checks are the Needs attention filter term for term, and
  // they come before anything that depends on what the session can read: a
  // failed apply is in the binding (intent), so a session without reality
  // still has it, and a row the filter keeps has to say why it was kept.
  if (row.driftState === "drift") {
    return {
      key: "drift",
      tone: "error",
      label: "Drifted",
      title: "The managed table on this node no longer matches the ruleset Lattice applied. Someone or something changed it outside the control plane.",
    };
  }
  if (row.lastError) {
    return { key: "apply-failed", tone: "error", label: "Apply failed", title: `The last apply failed: ${row.lastError}` };
  }
  if (hasFreshEvidence(view) && exposure.unexplained > 0) {
    const ports = plural(exposure.unexplained, "port", "ports");
    return {
      key: "unexplained",
      tone: "error",
      label: `${ports}, no rule`,
      title: `${ports} open to the internet that no rule allows.${exposure.enforced ? "" : " Nothing on this node enforces its rules."}`,
    };
  }
  if (!canSeeReality) {
    return {
      key: "intent-only",
      tone: "neutral",
      label: row.coverage === "managed" ? "Managed" : row.coverage === "observe_only" ? "Observe only" : row.coverage === "legacy" ? "Not adopted" : "No binding",
      title: "This session cannot read node reality, so only the declared intent is known.",
    };
  }
  if (row.snapshotStatus === "unknown" && !realityRead) {
    return { key: "reality-unread", tone: "neutral", label: "Not read", title: "The fleet's reality read failed, so this node's snapshot, drift and open ports are not known." };
  }
  if (row.snapshotStatus === "unknown") {
    return { key: "never-reported", tone: "neutral", label: "Never reported", title: "No snapshot has ever arrived from this node's agent, so what it has open is unknown." };
  }
  if (row.snapshotStatus === "stale" || exposure.evidence === "stale") {
    const stamp = stampUtc(row.collectedAt);
    return {
      key: "stale",
      tone: "warning",
      label: "Stale",
      title: `Last snapshot ${stamp || "at an unknown time"}, older than the server trusts, so its open ports are not judged.`,
    };
  }
  if (view.detail === "failed") {
    return { key: "snapshot-unread", tone: "warning", label: "Snapshot unread", title: "The node reported, but its snapshot could not be read, so what it has open is unknown." };
  }
  if (view.detail === "pending") {
    return { key: "reading", tone: "neutral", label: "Reading", title: "This node's snapshot is still being read." };
  }
  if (!exposure.rulesRead) {
    return { key: "not-judged", tone: "neutral", label: "Not judged", title: "The declared rules were not read, so no port on this node is judged." };
  }
  if (row.coverage === "managed") {
    if (row.driftState === "in_sync") {
      return { key: "enforced", tone: "healthy", label: "Enforced", title: "Lattice enforces this node's rules, and the live table matches what it applied." };
    }
    const reason = sentence(driftUnknownReason(row));
    if (!row.appliedTableSha) return { key: "never-applied", tone: "warning", label: "Never applied", title: reason };
    if (!row.managedSha) return { key: "no-managed-table", tone: "warning", label: "No managed table", title: reason };
    return { key: "unverified", tone: "warning", label: "Unverified", title: reason };
  }
  if (row.coverage === "unbound") {
    return { key: "no-binding", tone: "neutral", label: "No binding", title: "NetGuard governs nothing on this node: no binding attaches a group or a zone." };
  }
  return {
    key: "not-enforced",
    tone: "neutral",
    label: "Not enforced",
    title:
      row.coverage === "legacy"
        ? "Nothing open goes unexplained, but the legacy baseline is not adopted, so Lattice enforces nothing here."
        : "Nothing open goes unexplained, but this node is observe only, so Lattice enforces nothing here.",
  };
}

/**
 * Where each verdict sorts in the default order, worst first: the three that
 * need a hand, then the warnings (evidence too old, a snapshot that could not
 * be read, a managed node that cannot be verified), then the neutral states,
 * then enforced. Grouped by tone, so the Status column reads top to bottom
 * the way its dots are coloured; inside a tone, the order a node would be
 * chased in.
 */
const STATUS_RANK: Record<NodeStatusKey, number> = {
  drift: 0,
  "apply-failed": 1,
  unexplained: 2,
  stale: 3,
  "snapshot-unread": 4,
  "never-applied": 5,
  "no-managed-table": 6,
  unverified: 7,
  "never-reported": 8,
  "reality-unread": 9,
  reading: 10,
  "not-judged": 11,
  "intent-only": 12,
  "not-enforced": 13,
  "no-binding": 14,
  enforced: 15,
};

export function statusRank(key: NodeStatusKey): number {
  return STATUS_RANK[key];
}

/**
 * The default order of the Nodes table, the one the Status header shows as
 * sorted: by verdict rank, then, among nodes with ports no rule allows, the
 * one with more of them first, then by name. It ranks with the same
 * nodeStatus the column draws, so a red dot can never sit below a green one.
 */
export function attentionComparator(canSeeReality: boolean, realityRead: boolean): (a: ExposureRowView, b: ExposureRowView) => number {
  return (a, b) => {
    const left = nodeStatus(a, canSeeReality, realityRead).key;
    const right = nodeStatus(b, canSeeReality, realityRead).key;
    const rank = statusRank(left) - statusRank(right);
    if (rank) return rank;
    if (left === "unexplained") {
      const more = b.exposure.unexplained - a.exposure.unexplained;
      if (more) return more;
    }
    return a.row.nodeName.localeCompare(b.row.nodeName);
  };
}

/**
 * The open ports in reading order: the ones no rule allows first, then the
 * ones that could not be judged, then the allowed ones, each group in port
 * order. The status already counts the first group; putting it first means
 * the cell shows it even when the row is too narrow for the whole list.
 */
export function orderedOpen(open: readonly OpenSpan[]): OpenSpan[] {
  const rank = { unexplained: 0, unknown: 1, allowed: 2 } as const;
  return open
    .map((span, index) => ({ span, index }))
    .sort((a, b) => rank[a.span.verdict] - rank[b.span.verdict] || a.index - b.index)
    .map((entry) => entry.span);
}

/**
 * The confined ports as one quiet phrase after the open ones: "22, 3434
 * gated · 9100 via tailscale · 8443 via 10.7.0.0/24". A knock-gated port and
 * a port bound to one zone's address are the common cases and read as one
 * word each; anything else names its scope.
 */
export function confinedPhrase(confined: readonly ConfinedSpan[]): string {
  const gated = confined.filter((span) => span.scopes.includes(KNOCK_SCOPE));
  const rest = confined.filter((span) => !span.scopes.includes(KNOCK_SCOPE));
  const parts: string[] = [];
  if (gated.length) parts.push(`${formatSpans(gated)} gated`);
  const byScope = new Map<string, ConfinedSpan[]>();
  for (const span of rest) {
    const scope = span.bindZone ?? describeScopes(span.scopes);
    byScope.set(scope, [...(byScope.get(scope) ?? []), span]);
  }
  for (const [scope, spans] of byScope) parts.push(`${spans.map(formatSpan).join(", ")} via ${scope}`);
  return parts.join(" · ");
}

/** The Managed by cell: who governs the node, then its coverage when that is not "managed". */
export function managedCell(view: ExposureRowView): { names: string; note: string; absent: boolean } {
  const { row, exposure } = view;
  if (!exposure.rulesRead) return { names: "not read", note: "", absent: true };
  const managed = exposure.managedBy;
  if (managed.kind === "none") return { names: row.coverage === "unbound" ? "no binding" : "none", note: row.coverage === "observe_only" ? "observe only" : "", absent: true };
  const names = managed.kind === "legacy" ? "legacy rules" : managed.names.join(", ");
  const note = row.coverage === "observe_only" ? "observe only" : row.coverage === "legacy" ? "not adopted" : "";
  return { names, note, absent: false };
}
