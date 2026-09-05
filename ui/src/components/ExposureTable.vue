<script setup lang="ts">
/**
 * One row per node: what is open to the internet, who manages it, whether the
 * live table still matches, and how old the evidence is.
 *
 * The row is the chassis's record row. Its chevron opens the node's detail in
 * place beneath it (the `detail` slot), so the table stays on screen beside
 * the evidence instead of a panel mounting under the fold. Nothing is invented
 * for a node that has not reported: its exposure reads "unknown" with the
 * reason, never "nothing open".
 *
 * A port the node's knock table gates is confined, not open: it prints as a
 * "gated" chip under the open list rather than as a red unexplained mark.
 */
import {
  PcActionsCell,
  PcButton,
  PcDetailRow,
  PcKindChip,
  PcNameCell,
  PcRow,
  PcStatePill,
  PcTable,
  PcTd,
  PcTh,
  type NameStatus,
  type SortState,
} from "@latticenet/plugin-bridge/chassis";

import {
  KNOCK_SCOPE,
  describeScopes,
  formatProcesses,
  formatSpan,
  formatSpans,
  type ConfinedSpan,
  type ExposureSortKey,
  type NodeExposure,
  type OpenSpan,
} from "../exposure";
import {
  driftLabel,
  driftShortReason,
  driftToneFor,
  driftUnknownReason,
  snapshotToneFor,
  type PostureRow,
} from "../posture";
import { ageLabel, stampUtc } from "../time";
import { stateTone } from "../tones";

/** Whether this node's full snapshot has been fetched yet. */
export type DetailState = "pending" | "loaded" | "failed";

export interface ExposureRowView {
  row: PostureRow;
  exposure: NodeExposure;
  detail: DetailState;
}

const props = defineProps<{
  rows: readonly ExposureRowView[];
  sortKey: ExposureSortKey;
  sortDirection: "asc" | "desc";
  /** Node ids whose detail is open in place. */
  isOpen: (nodeId: string) => boolean;
  /** Finding keys the operator dismissed for this session. */
  ignored: ReadonlySet<string>;
  /** The instant the page fetched, which every age here is measured against. */
  observedAt: number;
  canSeeReality: boolean;
}>();

const emit = defineEmits<{
  (event: "sort", key: ExposureSortKey): void;
  (event: "toggle", nodeId: string): void;
  (event: "finding", key: string): void;
}>();

defineSlots<{
  detail(props: { view: ExposureRowView }): unknown;
}>();

const COLUMNS = 6;

function sortFor(key: ExposureSortKey): SortState {
  if (props.sortKey !== key) return "none";
  return props.sortDirection === "asc" ? "ascending" : "descending";
}

// ── cells ───────────────────────────────────────────────────────────────────

function findingKey(nodeId: string, span: OpenSpan): string {
  return `${nodeId}:${span.protocol}:${span.from}-${span.to}`;
}

function spanTitle(span: OpenSpan): string {
  const owner = formatProcesses(span);
  const verdict = span.verdict === "allowed" ? "a rule allows it from the internet" : "no rule allows it";
  return `${formatSpan(span)}/${span.protocol}${owner ? ` (${owner})` : ""}: ${verdict}`;
}

function isGated(span: ConfinedSpan): boolean {
  return span.scopes.includes(KNOCK_SCOPE);
}

function confinedTitle(span: ConfinedSpan): string {
  const owner = formatProcesses(span);
  return `${formatSpan(span)}${owner ? ` (${owner})` : ""}: reachable only through ${describeScopes(span.scopes)}`;
}

/** The whole cell as one sentence, for the title of a truncated cell. */
function exposureTitle(view: ExposureRowView): string {
  const { exposure } = view;
  const open = exposure.open.length ? `open: ${formatSpans(exposure.open)}` : "nothing open to the internet";
  const confined = exposure.confined.length
    ? `; confined: ${exposure.confined.map((span) => `${formatSpan(span)} (${describeScopes(span.scopes)})`).join(", ")}`
    : "";
  return `${open}${confined}`;
}

function managedLabel(view: ExposureRowView): string {
  const managed = view.exposure.managedBy;
  if (managed.kind === "legacy") return "legacy rules";
  if (managed.kind === "groups") return managed.names.join(", ");
  return "none";
}

/** The one qualifier that turns the group list into the truth about enforcement. */
function managedNote(view: ExposureRowView): string {
  const { row } = view;
  if (row.coverage === "observe_only") return "observe only";
  if (row.coverage === "legacy") return "not adopted";
  if (row.coverage === "unbound") return "no binding";
  if (row.lastError) return "apply failed";
  if (!row.lastAppliedAt) return "never applied";
  return "";
}

function driftTitle(row: PostureRow): string {
  if (row.driftState === "drift") return "The managed table on this node no longer matches the ruleset Lattice applied.";
  if (row.driftState === "unknown") return driftUnknownReason(row);
  return "The live managed table matches the ruleset Lattice applied.";
}

function seenLabel(view: ExposureRowView): string {
  const { row } = view;
  if (row.snapshotStatus === "unknown") return "never";
  return `${ageLabel(row.collectedAt, props.observedAt)} ago`;
}

function seenTitle(view: ExposureRowView): string {
  const { row } = view;
  if (row.snapshotStatus === "unknown") return "No snapshot has ever arrived from this node's agent.";
  const stamp = stampUtc(row.collectedAt);
  return row.snapshotStatus === "stale"
    ? `Last snapshot ${stamp}, older than the server trusts.`
    : `Snapshot collected ${stamp}.`;
}

/** The snapshot status as the quiet dot at the name baseline. */
function nameStatus(view: ExposureRowView): NameStatus {
  const status = view.row.snapshotStatus;
  return {
    tone: stateTone(snapshotToneFor(status)),
    label: status === "fresh" ? "ok" : status === "stale" ? "stale" : "never",
    title: seenTitle(view),
  };
}
</script>

<template>
  <!-- 880, not 1000: the floor has to clear a 1024 frame less the workspace
       padding and the card border, or the wrap scrolls sideways with its only
       scrollbar under the last row and the sticky actions column lands on the
       drift text. Below that the chassis marks the wrap and scrolls it. -->
  <PcTable :min-width="880" label="Exposure by node">
    <template #head>
      <PcTh name sortable :sort="sortFor('name')" @sort="emit('sort', 'name')">Node</PcTh>
      <PcTh class="ng-th-exposure" sortable :sort="sortFor('open')" @sort="emit('sort', 'open')">Exposure</PcTh>
      <PcTh sortable :sort="sortFor('managed')" @sort="emit('sort', 'managed')">Managed by</PcTh>
      <PcTh sortable :sort="sortFor('drift')" @sort="emit('sort', 'drift')">Drift</PcTh>
      <PcTh sortable :sort="sortFor('seen')" @sort="emit('sort', 'seen')">Seen</PcTh>
      <PcTh actions>Actions</PcTh>
    </template>

    <tbody v-for="view in rows" :key="view.row.nodeId" :data-open="isOpen(view.row.nodeId) ? 'true' : undefined">
      <PcRow
        :id="`node-${view.row.nodeId}`"
        :open="isOpen(view.row.nodeId)"
        :data-attention="view.exposure.unexplained > 0 || view.row.driftState === 'drift' ? 'true' : undefined"
      >
        <PcNameCell
          :name="view.row.nodeName"
          :id="view.row.nodeId"
          :expanded="isOpen(view.row.nodeId)"
          :controls="`detail-${view.row.nodeId}`"
          :status="nameStatus(view)"
          @toggle="emit('toggle', view.row.nodeId)"
        >
          <template #status>
            <PcStatePill :tone="stateTone(driftToneFor(view.row.driftState))" :label="driftLabel(view.row.driftState)" :title="driftTitle(view.row)" />
          </template>
        </PcNameCell>

        <PcTd label="Exposure" stack="summary" :title="exposureTitle(view)">
          <span class="ng-exposure">
            <template v-if="!canSeeReality">
              <span class="ng-absent">not readable by this session</span>
            </template>
            <template v-else-if="view.row.snapshotStatus === 'unknown'">
              <span class="ng-absent">unknown, never reported</span>
            </template>
            <template v-else-if="view.detail === 'failed'">
              <span class="ng-warn-text">unknown, snapshot could not be read</span>
            </template>
            <template v-else-if="view.detail === 'pending'">
              <span class="ng-absent">reading snapshot</span>
            </template>
            <template v-else-if="view.exposure.evidence === 'stale'">
              <span class="ng-warn-text">unknown, no snapshot since {{ stampUtc(view.exposure.collectedAt) }}</span>
              <small v-if="view.exposure.open.length">last seen: {{ formatSpans(view.exposure.open) }}</small>
            </template>
            <template v-else>
              <span v-if="!view.exposure.open.length" class="ng-absent" title="No listener binds a non-loopback address.">nothing</span>
              <span v-else class="ng-spans">
                <template v-for="(span, index) in view.exposure.open" :key="span.protocol + span.from">
                  <span v-if="index" class="ng-span-sep">, </span>
                  <button
                    v-if="span.verdict === 'unexplained'"
                    class="ng-span-open"
                    type="button"
                    :data-ignored="ignored.has(findingKey(view.row.nodeId, span)) ? 'true' : undefined"
                    :title="ignored.has(findingKey(view.row.nodeId, span)) ? `${spanTitle(span)}; ignored for this session` : spanTitle(span)"
                    @click.stop="emit('finding', findingKey(view.row.nodeId, span))"
                  >
                    {{ formatSpan(span) }}<span aria-hidden="true"> (!)</span>
                    <span class="pc-sr-only">, open with no rule allowing it</span>
                  </button>
                  <span v-else class="ng-span-allowed" :title="spanTitle(span)">{{ formatSpan(span) }}</span>
                </template>
              </span>
              <span v-if="view.exposure.confined.length" class="ng-confined">
                <template v-for="span in view.exposure.confined" :key="'c' + span.protocol + span.from">
                  <PcKindChip v-if="isGated(span)" :title="confinedTitle(span)">{{ formatSpan(span) }} gated</PcKindChip>
                  <span v-else class="ng-confined-item" :title="confinedTitle(span)">{{ formatSpan(span) }}: {{ describeScopes(span.scopes) }}</span>
                </template>
              </span>
            </template>
          </span>
        </PcTd>

        <PcTd label="Managed by" :title="managedLabel(view)">
          <span :class="view.exposure.managedBy.kind === 'none' ? 'ng-absent' : 'pc-mono'">{{ managedLabel(view) }}</span>
          <small v-if="managedNote(view)" :class="view.row.lastError ? 'pc-danger-text' : undefined">{{ managedNote(view) }}</small>
        </PcTd>

        <PcTd label="Drift" stack="state">
          <PcStatePill :tone="stateTone(driftToneFor(view.row.driftState))" :label="driftLabel(view.row.driftState)" :title="driftTitle(view.row)" />
          <small v-if="driftShortReason(view.row)" :class="view.row.driftState === 'drift' ? 'pc-danger-text' : undefined">{{ driftShortReason(view.row) }}</small>
        </PcTd>

        <PcTd label="Seen" mono :title="seenTitle(view)">
          <span :class="view.row.snapshotStatus === 'stale' ? 'ng-warn-text' : view.row.snapshotStatus === 'unknown' ? 'ng-absent' : undefined">{{ seenLabel(view) }}</span>
          <small v-if="view.row.snapshotStatus === 'stale'" class="ng-warn-text">stale</small>
        </PcTd>

        <PcActionsCell>
          <PcButton compact :title="`${isOpen(view.row.nodeId) ? 'Close' : 'Open'} the detail for ${view.row.nodeName}`" @click="emit('toggle', view.row.nodeId)">
            {{ isOpen(view.row.nodeId) ? 'Close' : 'Details' }}
          </PcButton>
        </PcActionsCell>
      </PcRow>

      <PcDetailRow v-if="isOpen(view.row.nodeId)" :id="`detail-${view.row.nodeId}`" :colspan="COLUMNS">
        <slot name="detail" :view="view" />
      </PcDetailRow>
    </tbody>
  </PcTable>
</template>
