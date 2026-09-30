<script setup lang="ts">
/**
 * The Overview's one picture: every port the fleet has open to the internet,
 * one row per port or bank. The bar is the share of counted nodes that open
 * it, split by verdict: no rule (the finding), bind not reported (may be open),
 * and allowed by a rule. The numbers are printed beside the bar, so colour is
 * never the only carrier. A row opens Nodes searched for that port.
 */
import { computed } from "vue";

import { PcButton, PcCount, PcEmptyState, PcPanel, PcPanelHeader } from "@latticenet/plugin-bridge/chassis";

import type { PortPicture, PortRow } from "../overview";

const props = defineProps<{
  picture: PortPicture;
  /** Snapshot reads still in flight. */
  reading: { done: number; total: number };
}>();

const emit = defineEmits<{
  (event: "port", search: string): void;
  (event: "nodes"): void;
}>();

const LIMIT = 10;
const rows = computed(() => props.picture.rows.slice(0, LIMIT));
const hidden = computed(() => Math.max(0, props.picture.rows.length - LIMIT));
const stillReading = computed(() => props.reading.total > 0 && props.reading.done < props.reading.total);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const description = computed(() => {
  const left = [
    props.picture.stale ? `${props.picture.stale} stale` : "",
    props.picture.neverReported ? `${props.picture.neverReported} never reported` : "",
    props.picture.unread ? `${props.picture.unread} still reading` : "",
  ].filter(Boolean);
  const base = `From ${plural(props.picture.counted, "fresh snapshot", "fresh snapshots")}; a bar is the share of those nodes with the port open.`;
  return left.length ? `${base} Not counted: ${left.join(", ")}.` : base;
});

function share(count: number): string {
  return props.picture.counted ? `${(count / props.picture.counted) * 100}%` : "0%";
}

/** The count's parts; only "no rule" is drawn in the attention colour, the node total stays plain. */
function counts(row: PortRow): { text: string; attention?: boolean }[] {
  const parts: { text: string; attention?: boolean }[] = [{ text: plural(row.total, "node", "nodes") }];
  if (row.unexplained) parts.push({ text: `${row.unexplained} no rule`, attention: true });
  if (row.unknown) parts.push({ text: `${row.unknown} bind not reported` });
  return parts;
}

function rowTitle(row: PortRow): string {
  const names = row.nodes.map((node) => `${node.nodeName} (${node.verdict === "unexplained" ? "no rule" : node.verdict === "unknown" ? "bind not reported" : "allowed"})`);
  return `${row.label}${row.processes.length ? ` ${row.processes.join(", ")}` : ""}: ${names.join(", ")}. Open Nodes searched for ${row.search}.`;
}
</script>

<template>
  <PcPanel label="Open to the internet, by port">
    <PcPanelHeader title="Open to the internet, by port" :description="description">
      <div class="ng-legend" aria-hidden="true">
        <span data-verdict="unexplained">no rule</span>
        <span data-verdict="unknown">bind not reported</span>
        <span data-verdict="allowed">allowed</span>
      </div>
      <PcCount v-if="picture.rows.length" :value="plural(picture.rows.length, 'port', 'ports')" />
    </PcPanelHeader>

    <PcEmptyState v-if="!picture.rows.length && stillReading" title="Still reading snapshots">
      <p>{{ reading.done }} of {{ reading.total }} snapshots read. A port appears here as its node's snapshot lands.</p>
    </PcEmptyState>
    <PcEmptyState v-else-if="!picture.rows.length && !picture.counted" title="No fresh snapshot to draw from">
      <p>Nothing here is known to be open or closed. Open ports are read from each node's snapshot, and no node has a fresh one.</p>
    </PcEmptyState>
    <PcEmptyState v-else-if="!picture.rows.length" title="Nothing is open to the internet">
      <p>No listener on {{ plural(picture.counted, 'fresh snapshot', 'fresh snapshots') }} binds an address the internet can reach.</p>
    </PcEmptyState>

    <ol v-else class="ng-ports">
      <li v-for="row in rows" :key="row.key">
        <button type="button" class="ng-port" :title="rowTitle(row)" @click="emit('port', row.search)">
          <span class="ng-port-label">
            <strong class="pc-mono">{{ row.label }}</strong>
            <small>{{ row.processes.join(', ') || 'owner not reported' }}</small>
          </span>
          <span class="ng-port-bar" aria-hidden="true">
            <span data-verdict="unexplained" :style="{ width: share(row.unexplained) }" />
            <span data-verdict="unknown" :style="{ width: share(row.unknown) }" />
            <span data-verdict="allowed" :style="{ width: share(row.allowed) }" />
          </span>
          <span class="ng-port-counts">
            <template v-for="(part, index) in counts(row)" :key="part.text">
              <template v-if="index"> · </template>
              <span :data-attention="part.attention ? 'true' : undefined">{{ part.text }}</span>
            </template>
          </span>
        </button>
      </li>
    </ol>
    <footer v-if="hidden" class="ng-ports-more">
      <span>{{ plural(hidden, 'more port', 'more ports') }}; the Nodes table lists every open port.</span>
      <PcButton compact @click="emit('nodes')">Open Nodes</PcButton>
    </footer>
  </PcPanel>
</template>
