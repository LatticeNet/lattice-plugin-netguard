<script setup lang="ts">
/**
 * One row per node, one line per row: the node, its verdict, what it has open
 * to the internet, who governs it, and how old the evidence is.
 *
 * The Status column is the row's answer to "does this node need me"
 * (nodeStatus.ts), at the left edge where the eye starts, so the port list
 * no longer has to carry the verdict in red marks of its own. A port no rule
 * allows is drawn as a small flagged token, first in the list: the token's
 * fill and border say "nothing allows this" without relying on colour alone,
 * and a screen reader hears it in words. Allowed ports are plain text; a port
 * that could not be judged is muted with a "?". Confined ports (knock gated,
 * bound to one zone) follow as one quiet phrase.
 *
 * The row has one click target, the node's panel, and one menu for the
 * actions that do not need the panel open. Nothing is invented for a node
 * that has not reported: its port cell says "unknown", never "nothing open".
 * From 480 to 720px the node column pins to the left edge and the verdict
 * moves into it, on a second line under the name (the chassis's narrow
 * status line), so it stays on screen while the rest of the row scrolls
 * sideways; the Status column steps aside there. Below 480px the row folds
 * into lines (node and menu, then the verdict, then the ports, wrapped) so a
 * phone shows every node's verdict and every port without scrolling sideways.
 *
 * After a failed overview read no port is judged against the rules: each
 * open one prints as unknown with that reason, and Managed by says the
 * binding was not read rather than "none".
 */
import { computed } from "vue";

import { PcActionsCell, PcRow, PcStateDot, PcTable, PcTd, PcTh, type SortState } from "@latticenet/plugin-bridge/chassis";

import { describeScopes, formatProcesses, formatSpan, formatSpans, type ExposureSortKey, type OpenSpan } from "../exposure";
import { idAddsInformation } from "../identity";
import { confinedPhrase, managedCell, nodeStatus, orderedOpen } from "../nodeStatus";
import type { ExposureRowView } from "../overview";
import type { PostureRow } from "../posture";
import type { MenuItem } from "../rowMenu";
import { ageLabel, stampUtc } from "../time";
import RowMenu from "./RowMenu.vue";

const props = defineProps<{
  rows: readonly ExposureRowView[];
  /** The column the rows are sorted by; null when a query's sort: orders them by a field no column shows. */
  sortKey: ExposureSortKey | null;
  sortDirection: "asc" | "desc";
  /** The node whose panel is open. */
  activeId: string;
  /** The row menu's items for a node; an empty list draws no trigger. */
  menuFor: (row: PostureRow) => MenuItem[];
  /** Finding keys the operator dismissed for this session. */
  ignored: ReadonlySet<string>;
  /** Now, for the Seen ages. */
  now: number;
  canSeeReality: boolean;
  /** False when the session may read reality but the read failed. */
  realityRead: boolean;
}>();

const emit = defineEmits<{
  (event: "sort", key: ExposureSortKey): void;
  (event: "open", nodeId: string): void;
  (event: "action", key: string, nodeId: string): void;
}>();

/**
 * Each row's cells, worked out once per render rather than once per binding:
 * the verdict, the Managed by line, the ports in reading order, the confined
 * phrase, the menu, and whether the id says anything the name does not.
 */
const lines = computed(() =>
  props.rows.map((view) => ({
    view,
    status: nodeStatus(view, props.canSeeReality, props.realityRead),
    managed: managedCell(view),
    open: orderedOpen(view.exposure.open),
    confined: confinedPhrase(view.exposure.confined),
    menu: props.menuFor(view.row),
    showId: idAddsInformation(view.row.nodeName, view.row.nodeId),
  })),
);

/** A menu column only when some row has something in it. */
const hasMenus = computed(() => lines.value.some((line) => line.menu.length > 0));

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

/** The whole cell as one sentence, for the title of a truncated cell. */
function exposureTitle(view: ExposureRowView): string {
  const { exposure } = view;
  const open = exposure.open.length ? `open: ${formatSpans(exposure.open)}` : "nothing open to the internet";
  const confined = exposure.confined.length
    ? `; confined: ${exposure.confined.map((span) => `${formatSpan(span)} (${describeScopes(span.scopes)})`).join(", ")}`
    : "";
  return `${open}${confined}`;
}

/* A session without the reality and review methods never asked when a node
   last reported, so its rows say the age is not readable, not "never". */
function seenLabel(view: ExposureRowView): string {
  const { row } = view;
  if (!props.canSeeReality) return "not readable";
  if (row.snapshotStatus === "unknown") return props.realityRead ? "never" : "not read";
  return `${ageLabel(row.collectedAt, props.now)} ago`;
}

function seenTitle(view: ExposureRowView): string {
  const { row } = view;
  if (!props.canSeeReality) return "This session cannot read node reality, so when this node last reported is not known.";
  if (row.snapshotStatus === "unknown") return props.realityRead ? "No snapshot has ever arrived from this node's agent." : "The reality read failed, so when this node last reported is not known.";
  const stamp = stampUtc(row.collectedAt);
  return row.snapshotStatus === "stale"
    ? `Last snapshot ${stamp}, older than the server trusts.`
    : `Snapshot collected ${stamp}.`;
}
</script>

<template>
  <!-- 880, not 1000: the floor has to clear a 1024 frame less the workspace
       padding and the card border, or the wrap scrolls sideways with its only
       scrollbar under the last row. Between 480 and 720 the wrap scrolls
       sideways under the pinned node column; below 480 the rows fold. -->
  <PcTable class="ng-exposure-table" :min-width="880" label="Exposure by node">
    <template #head>
      <PcTh name sortable :sort="sortFor('name')" @sort="emit('sort', 'name')">Node</PcTh>
      <PcTh class="ng-th-status" sortable :sort="sortFor('attention')" @sort="emit('sort', 'attention')">Status</PcTh>
      <PcTh class="ng-th-exposure" sortable :sort="sortFor('open')" @sort="emit('sort', 'open')">Open to the internet</PcTh>
      <PcTh sortable :sort="sortFor('managed')" @sort="emit('sort', 'managed')">Managed by</PcTh>
      <PcTh class="ng-th-seen" sortable :sort="sortFor('seen')" @sort="emit('sort', 'seen')">Seen</PcTh>
      <PcTh v-if="hasMenus" actions><span class="pc-sr-only">Actions</span></PcTh>
    </template>

    <tbody>
      <PcRow
        v-for="{ view, status, managed, open, confined, menu, showId } in lines"
        :id="`node-${view.row.nodeId}`"
        :key="view.row.nodeId"
        class="ng-click-row"
        :selected="activeId === view.row.nodeId"
        :data-attention="status.tone === 'error' ? 'true' : undefined"
        @click="openRow($event, view.row.nodeId)"
      >
        <td class="pc-name" data-stack="name">
          <div class="pc-name-line">
            <button
              class="ng-row-open"
              type="button"
              :title="`Open ${view.row.nodeName} (${view.row.nodeId})`"
              :aria-current="activeId === view.row.nodeId ? 'true' : undefined"
              @click.stop="openRow($event, view.row.nodeId)"
            >{{ view.row.nodeName }}</button>
          </div>
          <small v-if="showId" :title="view.row.nodeId">{{ view.row.nodeId }}</small>
          <span class="pc-narrow-status"><PcStateDot :tone="status.tone" :label="status.label" :title="status.title" /></span>
        </td>

        <PcTd label="Status" stack="state" class="ng-status-cell">
          <PcStateDot :tone="status.tone" :label="status.label" :title="status.title" />
        </PcTd>

        <PcTd label="Open to the internet" stack="summary" :title="exposureTitle(view)">
          <span class="ng-exposure">
            <template v-if="!canSeeReality">
              <span class="ng-absent">not readable by this session</span>
            </template>
            <template v-else-if="view.row.snapshotStatus === 'unknown'">
              <span class="ng-absent">unknown</span>
            </template>
            <template v-else-if="view.detail === 'failed'">
              <span class="ng-absent">unknown, snapshot could not be read</span>
            </template>
            <template v-else-if="view.detail === 'pending'">
              <span class="ng-absent">reading snapshot</span>
            </template>
            <template v-else-if="view.exposure.evidence === 'stale'">
              <span class="ng-absent">{{ view.exposure.open.length ? `last seen ${formatSpans(view.exposure.open)}` : 'unknown' }}</span>
            </template>
            <template v-else>
              <span v-if="!view.exposure.open.length" class="ng-absent" title="No listener binds a non-loopback address.">nothing open</span>
              <template v-for="span in open" :key="span.protocol + span.from">
                <span
                  v-if="span.verdict === 'unexplained'"
                  class="ng-span-open"
                  :data-ignored="ignored.has(findingKey(view.row.nodeId, span)) ? 'true' : undefined"
                  :title="ignored.has(findingKey(view.row.nodeId, span)) ? `${spanTitle(span, true)}; ignored for this session` : spanTitle(span, true)"
                >{{ formatSpan(span) }}<span class="pc-sr-only">, open with no rule allowing it</span></span>
                <span v-else-if="span.verdict === 'unknown'" class="ng-span-unknown" :title="spanTitle(span, view.exposure.rulesRead)"
                  >{{ formatSpan(span) }}<span aria-hidden="true">?</span><span class="pc-sr-only">{{ view.exposure.rulesRead ? ', bind address not reported' : ', not judged: the rules were not read' }}</span></span
                >
                <span v-else class="ng-span-allowed" :title="spanTitle(span, true)">{{ formatSpan(span) }}</span>
              </template>
              <span v-if="confined" class="ng-confined">{{ confined }}</span>
            </template>
          </span>
        </PcTd>

        <PcTd label="Managed by" stack="state" class="ng-managed-cell" :title="[managed.names, managed.note].filter(Boolean).join(', ')">
          <span class="ng-managed-line">
            <span :class="managed.absent ? 'ng-absent' : undefined">{{ managed.names }}</span>
            <span v-if="managed.note" class="ng-managed-note">{{ managed.note }}</span>
          </span>
        </PcTd>

        <PcTd label="Seen" stack="state" class="ng-seen-cell" :title="seenTitle(view)">
          <span :data-snapshot="view.row.snapshotStatus">{{ seenLabel(view) }}</span>
        </PcTd>

        <PcActionsCell v-if="hasMenus">
          <RowMenu v-if="menu.length" :label="`Actions for ${view.row.nodeName}`" :items="menu" @select="(key) => emit('action', key, view.row.nodeId)" />
        </PcActionsCell>
      </PcRow>
    </tbody>
  </PcTable>
</template>
