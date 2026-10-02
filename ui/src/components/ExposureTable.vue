<script setup lang="ts">
/**
 * One row per node: what is open to the internet, who manages it, whether the
 * live table still matches, and how old the evidence is.
 *
 * The row has one click target, the node's panel, and one menu for the
 * actions that do not need the panel open. Nothing is invented for a node
 * that has not reported: its exposure reads "unknown" with the reason, never
 * "nothing open". The columns stay at every width; below 720px the node
 * column pins to the left edge and the table scrolls sideways under it.
 *
 * A port the node's knock table gates is confined, not open: it prints as a
 * "gated" chip under the open list rather than as a red unexplained mark.
 *
 * After a failed overview read no port is judged against the rules: each
 * open one prints as unknown with that reason, and Managed by says the
 * binding was not read rather than "none".
 */
import { computed } from "vue";

import {
  PcActionsCell,
  PcKindChip,
  PcRow,
  PcStatePill,
  PcTable,
  PcTd,
  PcTh,
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
  type OpenSpan,
} from "../exposure";
import {
  driftLabel,
  driftShortReason,
  driftToneFor,
  driftUnknownReason,
  type PostureRow,
} from "../posture";
import type { ExposureRowView } from "../overview";
import type { MenuItem } from "../rowMenu";
import { ageLabel, stampUtc } from "../time";
import { stateTone } from "../tones";
import RowMenu from "./RowMenu.vue";

const props = defineProps<{
  rows: readonly ExposureRowView[];
  sortKey: ExposureSortKey;
  sortDirection: "asc" | "desc";
  /** The node whose panel is open. */
  activeId: string;
  /** The row menu's items for a node; an empty list draws no trigger. */
  menuFor: (row: PostureRow) => MenuItem[];
  /** Finding keys the operator dismissed for this session. */
  ignored: ReadonlySet<string>;
  /** The instant the page fetched, which every age here is measured against. */
  /** Now, for the Seen ages. */
  now: number;
  canSeeReality: boolean;
}>();

const emit = defineEmits<{
  (event: "sort", key: ExposureSortKey): void;
  (event: "open", nodeId: string): void;
  (event: "action", key: string, nodeId: string): void;
}>();

/** A menu column only when some row has something in it. */
const hasMenus = computed(() => props.rows.some((view) => props.menuFor(view.row).length > 0));

/** A click anywhere on the row opens it; the name button is where focus lands, so closing the panel hands focus back to it. */
function openRow(event: MouseEvent, nodeId: string): void {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  const row = (event.currentTarget as HTMLElement | null)?.closest("tr");
  row?.querySelector<HTMLButtonElement>(".ng-row-open")?.focus({ preventScroll: true });
  emit("open", nodeId);
}

function sortFor(key: ExposureSortKey): SortState {
  if (props.sortKey !== key) return "none";
  return props.sortDirection === "asc" ? "ascending" : "descending";
}

// ── cells ───────────────────────────────────────────────────────────────────

function findingKey(nodeId: string, span: OpenSpan): string {
  return `${nodeId}:${span.protocol}:${span.from}-${span.to}`;
}

function spanTitle(span: OpenSpan, rulesRead: boolean): string {
  const owner = formatProcesses(span);
  const verdict =
    span.verdict === "allowed"
      ? "a rule allows it from the internet"
      : span.verdict === "unknown"
        ? rulesRead
          ? "the snapshot does not say which address it is bound to, so where it can be reached from is unknown"
          : "the declared rules were not read, so whether a rule allows it is unknown"
        : "no rule allows it";
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
  if (!view.exposure.rulesRead) return "not read";
  const managed = view.exposure.managedBy;
  if (managed.kind === "legacy") return "legacy rules";
  if (managed.kind === "groups") return managed.names.join(", ");
  return "none";
}

/** The one qualifier that turns the group list into the truth about enforcement. */
function managedNote(view: ExposureRowView): string {
  const { row } = view;
  if (!view.exposure.rulesRead) return row.lastError ? "apply failed" : "";
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
  return `${ageLabel(row.collectedAt, props.now)} ago`;
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
  <!-- 880, not 1000: the floor has to clear a 1024 frame less the workspace
       padding and the card border, or the wrap scrolls sideways with its only
       scrollbar under the last row. Below that the wrap scrolls sideways and
       the node column stays pinned. `stacked` is off: rows are compared, so
       they keep their columns at 375 instead of turning into cards. -->
  <PcTable class="ng-exposure-table" :min-width="880" :stacked="false" label="Exposure by node">
    <template #head>
      <PcTh name sortable :sort="sortFor('name')" @sort="emit('sort', 'name')">Node</PcTh>
      <PcTh class="ng-th-exposure" sortable :sort="sortFor('open')" @sort="emit('sort', 'open')">Exposure</PcTh>
      <PcTh sortable :sort="sortFor('managed')" @sort="emit('sort', 'managed')">Managed by</PcTh>
      <PcTh sortable :sort="sortFor('drift')" @sort="emit('sort', 'drift')">Drift</PcTh>
      <PcTh sortable :sort="sortFor('seen')" @sort="emit('sort', 'seen')">Seen</PcTh>
      <PcTh v-if="hasMenus" actions><span class="pc-sr-only">Actions</span></PcTh>
    </template>

    <tbody>
      <PcRow
        v-for="view in rows"
        :id="`node-${view.row.nodeId}`"
        :key="view.row.nodeId"
        class="ng-click-row"
        :selected="activeId === view.row.nodeId"
        :data-attention="view.exposure.unexplained > 0 || view.row.driftState === 'drift' ? 'true' : undefined"
        @click="openRow($event, view.row.nodeId)"
      >
        <td class="pc-name" data-stack="name">
          <div class="pc-name-line">
            <button
              class="ng-row-open"
              type="button"
              :title="`Open ${view.row.nodeName}`"
              :aria-current="activeId === view.row.nodeId ? 'true' : undefined"
              @click.stop="openRow($event, view.row.nodeId)"
            >{{ view.row.nodeName }}</button>
          </div>
          <small :title="view.row.nodeId">{{ view.row.nodeId }}</small>
        </td>

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
                  <span
                    v-if="span.verdict === 'unexplained'"
                    class="ng-span-open"
                    :data-ignored="ignored.has(findingKey(view.row.nodeId, span)) ? 'true' : undefined"
                    :title="ignored.has(findingKey(view.row.nodeId, span)) ? `${spanTitle(span, true)}; ignored for this session` : spanTitle(span, true)"
                  >
                    {{ formatSpan(span) }}<span aria-hidden="true"> (!)</span>
                    <span class="pc-sr-only">, open with no rule allowing it</span>
                  </span>
                  <span v-else-if="span.verdict === 'unknown'" class="ng-span-unknown" :title="spanTitle(span, view.exposure.rulesRead)">
                    {{ formatSpan(span) }}<span aria-hidden="true"> (?)</span>
                    <span class="pc-sr-only">{{ view.exposure.rulesRead ? ', bind address not reported' : ', not judged: the rules were not read' }}</span>
                  </span>
                  <span v-else class="ng-span-allowed" :title="spanTitle(span, true)">{{ formatSpan(span) }}</span>
                </template>
              </span>
              <span v-if="view.exposure.confined.length" class="ng-confined">
                <template v-for="span in view.exposure.confined" :key="'c' + span.protocol + span.from">
                  <PcKindChip v-if="isGated(span)" :title="confinedTitle(span)">{{ formatSpan(span) }} gated</PcKindChip>
                  <PcKindChip v-else-if="span.bindZone" :title="confinedTitle(span)">{{ formatSpan(span) }} {{ span.bindZone }}</PcKindChip>
                  <span v-else class="ng-confined-item" :title="confinedTitle(span)">{{ formatSpan(span) }}: {{ describeScopes(span.scopes) }}</span>
                </template>
              </span>
            </template>
          </span>
        </PcTd>

        <PcTd label="Managed by" :title="managedLabel(view)">
          <span :class="view.exposure.managedBy.kind === 'none' || !view.exposure.rulesRead ? 'ng-absent' : 'pc-mono'">{{ managedLabel(view) }}</span>
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

        <PcActionsCell v-if="hasMenus">
          <RowMenu
            v-if="menuFor(view.row).length"
            :label="`Actions for ${view.row.nodeName}`"
            :items="menuFor(view.row)"
            @select="(key) => emit('action', key, view.row.nodeId)"
          />
        </PcActionsCell>
      </PcRow>
    </tbody>
  </PcTable>
</template>
