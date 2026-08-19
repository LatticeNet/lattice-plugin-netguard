<script setup lang="ts">
/**
 * The fleet, sortable, with intent and reality on the same row.
 *
 * Every column is a fact a firewall operator triages on. Nothing is invented
 * for a node that has not reported: a missing count renders as "not reported",
 * never as zero, because zero listeners and no information are opposite
 * findings.
 */
import { computed } from "vue";
import { ChevronDown, ChevronUp, Radar } from "@lucide/vue";

import StatusPill from "./StatusPill.vue";
import {
  coverageLabel,
  coverageTone,
  driftLabel,
  driftToneFor,
  driftUnknownReason,
  snapshotLabel,
  snapshotToneFor,
  type PostureRow,
  type SortDirection,
  type SortKey,
} from "../posture";

const props = defineProps<{
  rows: readonly PostureRow[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  selected: string;
  loading: boolean;
}>();

const emit = defineEmits<{
  (event: "sort", key: SortKey): void;
  (event: "open", nodeId: string): void;
}>();

interface Column {
  key: SortKey;
  label: string;
  align?: "right";
}

const columns: Column[] = [
  { key: "name", label: "Node" },
  { key: "coverage", label: "Authority" },
  { key: "snapshot", label: "Reporting" },
  { key: "drift", label: "Drift" },
  { key: "listeners", label: "Listeners", align: "right" },
  { key: "foreign_tables", label: "Foreign", align: "right" },
  { key: "last_applied", label: "Last applied" },
];

const empty = computed(() => !props.loading && props.rows.length === 0);

function relative(value: string | undefined): string {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "unknown";
  const seconds = Math.round((Date.now() - parsed) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function absolute(value: string | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toLocaleString();
}
</script>

<template>
  <section class="panel">
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :class="column.align === 'right' ? 'numeric' : undefined"
              :aria-sort="sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
            >
              <button class="sort-button" type="button" @click="emit('sort', column.key)">
                {{ column.label }}
                <ChevronUp v-if="sortKey === column.key && sortDirection === 'asc'" :size="12" />
                <ChevronDown v-else-if="sortKey === column.key" :size="12" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.nodeId"
            class="row-open"
            :data-selected="row.nodeId === selected"
            tabindex="0"
            @click="emit('open', row.nodeId)"
            @keydown.enter="emit('open', row.nodeId)"
            @keydown.space.prevent="emit('open', row.nodeId)"
          >
            <td>
              <strong>{{ row.nodeName }}</strong>
              <small class="mono">{{ row.nodeId }}</small>
              <!-- Repeated from the drift column, shown only when that column
                   has been pushed off the side by a narrow frame. -->
              <span class="row-drift">
                <StatusPill
                  :tone="driftToneFor(row.driftState)"
                  :label="driftLabel(row.driftState)"
                  :title="row.driftState === 'unknown' ? driftUnknownReason(row) : undefined"
                />
              </span>
            </td>
            <td>
              <StatusPill :tone="coverageTone(row.coverage)" :label="coverageLabel(row.coverage)" />
              <small v-if="row.lastError" class="danger-text">{{ row.lastError }}</small>
            </td>
            <td>
              <StatusPill
                :tone="snapshotToneFor(row.snapshotStatus)"
                :label="snapshotLabel(row.snapshotStatus)"
              />
              <small v-if="row.collectedAt" :title="absolute(row.collectedAt)">
                {{ relative(row.collectedAt) }}
              </small>
              <small v-else>waiting for the node agent</small>
            </td>
            <td>
              <StatusPill
                :tone="driftToneFor(row.driftState)"
                :label="driftLabel(row.driftState)"
                :title="row.driftState === 'unknown' ? driftUnknownReason(row) : undefined"
              />
              <small v-if="row.driftState === 'drift'" class="danger-text">
                live table differs from the applied ruleset
              </small>
            </td>
            <td class="numeric mono">
              <template v-if="row.listenerCount === undefined">
                <span class="absent">not reported</span>
              </template>
              <template v-else>{{ row.listenerCount }}</template>
            </td>
            <td class="numeric mono">
              <template v-if="row.foreignTableCount === undefined">
                <span class="absent">not reported</span>
              </template>
              <template v-else-if="row.foreignTableCount === 0">0</template>
              <template v-else>
                <span class="warn-text">{{ row.foreignTableCount }}</span>
              </template>
            </td>
            <td>
              <template v-if="row.lastAppliedAt">
                <span :title="absolute(row.lastAppliedAt)">{{ relative(row.lastAppliedAt) }}</span>
                <small class="mono">{{ (row.appliedTableSha || '').slice(0, 12) || 'no hash recorded' }}</small>
              </template>
              <span v-else class="absent">never applied by Lattice</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="empty" class="empty">
      <Radar :size="26" />
      <strong>No nodes in this view</strong>
      <span>Clear the search or the posture filter above. If neither is set, this session can see no nodes at all.</span>
    </div>
  </section>
</template>
