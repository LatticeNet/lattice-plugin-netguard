<script setup lang="ts">
/**
 * One row per node: what is open to the internet, who manages it, whether the
 * live table still matches, and how old the evidence is.
 *
 * The three vocabularies the old fleet table made the operator hold together
 * (coverage, snapshot, drift) collapse into MANAGED BY, SEEN and DRIFT, and
 * the exposure column carries the answer the page exists for. Nothing is
 * invented for a node that has not reported: its exposure reads "unknown" with
 * the reason, never "nothing open".
 *
 * Below the desktop breakpoint the box scrolls sideways with the node column
 * stuck to its left edge. The right edge fades and a caption names the columns
 * that continue past it while there is more to scroll, so a clipped cell is
 * never mistaken for an empty one.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, ChevronRight, ChevronUp, CircleAlert, Radar, RefreshCw } from "@lucide/vue";

import StatusPill from "./StatusPill.vue";
import {
  formatProcesses,
  formatSpan,
  formatSpans,
  describeScopes,
  type ExposureSortKey,
  type NodeExposure,
  type OpenSpan,
} from "../exposure";
import { driftLabel, driftShortReason, driftToneFor, driftUnknownReason, type PostureRow } from "../posture";
import { ageLabel, stampUtc } from "../time";

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
  selected: string;
  /** Finding keys the operator dismissed for this session. */
  ignored: ReadonlySet<string>;
  /** The instant the page fetched, which every age here is measured against. */
  observedAt: number;
  canSeeReality: boolean;
  /** The load failure, when there is one; with no rows it is the whole state. */
  error: string;
  /** Why the table is empty when it is, in the operator's terms. */
  emptyMessage: string;
}>();

const emit = defineEmits<{
  (event: "sort", key: ExposureSortKey): void;
  (event: "open", nodeId: string): void;
  (event: "finding", key: string): void;
  (event: "refresh"): void;
}>();

const columns: { key: ExposureSortKey; label: string }[] = [
  { key: "name", label: "Node" },
  { key: "open", label: "Open to the internet" },
  { key: "managed", label: "Managed by" },
  { key: "drift", label: "Drift" },
  { key: "seen", label: "Seen" },
];

// ── the sideways scroll affordance ──────────────────────────────────────────

const box = ref<HTMLElement>();
const moreRight = ref(false);

function measure(): void {
  const el = box.value;
  moreRight.value = Boolean(el) && el!.scrollLeft + el!.clientWidth < el!.scrollWidth - 1;
}

onMounted(() => {
  measure();
  window.addEventListener("resize", measure, { passive: true });
});
onBeforeUnmount(() => window.removeEventListener("resize", measure));
watch(() => props.rows, () => void requestAnimationFrame(measure));

// ── cells ───────────────────────────────────────────────────────────────────

function findingKey(nodeId: string, span: OpenSpan): string {
  return `${nodeId}:${span.protocol}:${span.from}-${span.to}`;
}

function spanTitle(span: OpenSpan): string {
  const owner = formatProcesses(span);
  const verdict = span.verdict === "allowed" ? "a rule allows it from the internet" : "no rule allows it";
  return `${formatSpan(span)}/${span.protocol}${owner ? ` (${owner})` : ""}: ${verdict}`;
}

function confinedLine(exposure: NodeExposure): string {
  return exposure.confined.map((span) => `${formatSpan(span)}: ${describeScopes(span.scopes)}`).join(" · ");
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
  return ageLabel(row.collectedAt, props.observedAt);
}

function seenTitle(view: ExposureRowView): string {
  const { row } = view;
  if (row.snapshotStatus === "unknown") return "No snapshot has ever arrived from this node's agent.";
  const stamp = stampUtc(row.collectedAt);
  return row.snapshotStatus === "stale"
    ? `Last snapshot ${stamp}, older than the server trusts.`
    : `Snapshot collected ${stamp}.`;
}
</script>

<template>
  <section class="panel">
    <div v-if="error && !rows.length" class="empty error-state" role="alert">
      <CircleAlert :size="26" />
      <strong>Nothing could be loaded</strong>
      <span class="pre-line">{{ error }}</span>
      <button class="button secondary" type="button" @click="emit('refresh')"><RefreshCw :size="14" />Refresh</button>
    </div>

    <template v-else>
      <div ref="box" class="table-scroll" :data-more-right="moreRight" @scroll.passive="measure">
        <table class="exposure-table">
          <thead>
            <tr>
              <th
                v-for="column in columns"
                :key="column.key"
                :aria-sort="sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
              >
                <button class="sort-button" type="button" @click="emit('sort', column.key)">
                  {{ column.label }}
                  <ChevronUp v-if="sortKey === column.key && sortDirection === 'asc'" :size="12" />
                  <ChevronDown v-else-if="sortKey === column.key" :size="12" />
                </button>
              </th>
              <th class="actions-head"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="view in rows"
              :key="view.row.nodeId"
              class="row-open"
              :data-selected="view.row.nodeId === selected"
              :data-attention="view.exposure.unexplained > 0 || view.row.driftState === 'drift'"
              tabindex="0"
              @click="emit('open', view.row.nodeId)"
              @keydown.enter="emit('open', view.row.nodeId)"
              @keydown.space.prevent="emit('open', view.row.nodeId)"
            >
              <td class="node-cell">
                <strong>{{ view.row.nodeName }}</strong>
                <small class="mono">{{ view.row.nodeId }}</small>
              </td>

              <td class="exposure-cell">
                <template v-if="!canSeeReality">
                  <span class="absent">not readable by this session</span>
                </template>
                <template v-else-if="view.row.snapshotStatus === 'unknown'">
                  <span class="absent">unknown, never reported</span>
                </template>
                <template v-else-if="view.detail === 'failed'">
                  <span class="warn-text">unknown, snapshot could not be read</span>
                </template>
                <template v-else-if="view.detail === 'pending'">
                  <span class="absent">reading snapshot</span>
                </template>
                <template v-else-if="view.exposure.evidence === 'stale'">
                  <span class="warn-text">unknown, no snapshot since {{ stampUtc(view.exposure.collectedAt) }}</span>
                  <small v-if="view.exposure.open.length" class="mono">last seen: {{ formatSpans(view.exposure.open) }}</small>
                </template>
                <template v-else>
                  <span v-if="!view.exposure.open.length" class="absent" title="No listener binds a non-loopback address.">nothing</span>
                  <span v-else class="spans">
                    <template v-for="(span, index) in view.exposure.open" :key="span.protocol + span.from">
                      <span v-if="index" class="span-sep">, </span>
                      <button
                        v-if="span.verdict === 'unexplained'"
                        class="span-chip"
                        type="button"
                        :data-ignored="ignored.has(findingKey(view.row.nodeId, span))"
                        :title="ignored.has(findingKey(view.row.nodeId, span)) ? `${spanTitle(span)}; ignored for this session` : spanTitle(span)"
                        @click.stop="emit('finding', findingKey(view.row.nodeId, span))"
                      >
                        {{ formatSpan(span) }}<span aria-hidden="true"> (!)</span>
                        <span class="visually-hidden">, open with no rule allowing it</span>
                      </button>
                      <span v-else class="mono span-allowed" :title="spanTitle(span)">{{ formatSpan(span) }}</span>
                    </template>
                  </span>
                  <small v-if="view.exposure.confined.length" class="mono confined-line">{{ confinedLine(view.exposure) }}</small>
                </template>
              </td>

              <td class="managed-cell">
                <span :class="view.exposure.managedBy.kind === 'none' ? 'absent' : 'mono'">{{ managedLabel(view) }}</span>
                <small v-if="managedNote(view)" :class="view.row.lastError ? 'danger-text' : undefined">{{ managedNote(view) }}</small>
              </td>

              <td class="drift-cell">
                <StatusPill :tone="driftToneFor(view.row.driftState)" :label="driftLabel(view.row.driftState)" :title="driftTitle(view.row)" />
                <small v-if="driftShortReason(view.row)" :class="view.row.driftState === 'drift' ? 'danger-text' : undefined">{{ driftShortReason(view.row) }}</small>
              </td>

              <td class="seen-cell mono" :data-tone="view.row.snapshotStatus">
                <span :title="seenTitle(view)">{{ seenLabel(view) }}</span>
                <small v-if="view.row.snapshotStatus === 'stale'" class="warn-text">stale</small>
              </td>

              <td class="actions-cell">
                <span class="row-actions">
                  <button class="icon-button bordered" type="button" :aria-label="`Details for ${view.row.nodeName}`" title="Details" @click.stop="emit('open', view.row.nodeId)">
                    <ChevronRight :size="14" />
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="moreRight" class="table-hint">Managed by, Drift and Seen continue to the right. Scroll the table sideways.</p>

      <div v-if="!rows.length" class="empty">
        <Radar :size="26" />
        <strong>No nodes in this view</strong>
        <span>{{ emptyMessage }}</span>
      </div>
    </template>
  </section>
</template>
