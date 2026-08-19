<script setup lang="ts">
/**
 * The fleet in one line.
 *
 * This is the surface's signature element and the answer to the question an
 * operator actually opens NetGuard with: is anything wrong right now. It is a
 * proportional bar rather than four number tiles because the shape of a fleet
 * where 35 of 40 nodes have never reported should be visible before any digit
 * is read, and each segment filters the table below it.
 */
import { computed } from "vue";

import type { PostureCounts, PostureFilter } from "../posture";

const props = defineProps<{ counts: PostureCounts; active: PostureFilter }>();
const emit = defineEmits<{ (event: "select", filter: PostureFilter): void }>();

interface Segment {
  key: PostureFilter;
  tone: "ok" | "warn" | "danger" | "muted";
  label: string;
  value: number;
  hint: string;
}

const segments = computed<Segment[]>(() => {
  const c = props.counts;
  return [
    {
      key: "drifted",
      tone: "danger",
      label: "drifted",
      value: c.drifted,
      hint: "the live managed table no longer matches what Lattice applied",
    },
    {
      key: "apply_error",
      tone: "danger",
      label: "apply failed",
      value: c.withApplyError,
      hint: "the last apply recorded an error and the node may be on an older ruleset",
    },
    {
      key: "stale",
      tone: "warn",
      label: "stale",
      value: c.stale,
      hint: "reported once, but not recently enough to trust",
    },
    {
      key: "never_reported",
      tone: "muted",
      label: "never reported",
      value: c.neverReported,
      hint: "no snapshot has ever arrived, so drift cannot be computed for these nodes",
    },
    {
      key: "all",
      tone: "ok",
      label: "in sync",
      value: c.inSync,
      hint: "reported recently and matching what Lattice applied",
    },
  ];
});

const visible = computed(() => segments.value.filter((segment) => segment.value > 0));
const total = computed(() => Math.max(1, props.counts.total));
</script>

<template>
  <section class="posture" aria-label="Fleet firewall posture">
    <div class="posture-head">
      <div>
        <h2>Fleet posture</h2>
        <p>
          {{ counts.total }} visible {{ counts.total === 1 ? 'node' : 'nodes' }},
          {{ counts.managed }} under NetGuard authority.
          <template v-if="counts.neverReported">
            Drift cannot be computed for {{ counts.neverReported }} of them until their agent reports.
          </template>
          <template v-else-if="!counts.total">
            No nodes are visible to this session.
          </template>
        </p>
      </div>
      <button
        v-if="active !== 'all'"
        class="button secondary compact"
        type="button"
        @click="emit('select', 'all')"
      >
        Clear filter
      </button>
    </div>

    <div v-if="counts.total" class="posture-bar" role="img"
      :aria-label="`${counts.drifted} drifted, ${counts.stale} stale, ${counts.neverReported} never reported, ${counts.inSync} in sync`">
      <span
        v-for="segment in visible"
        :key="segment.key + segment.label"
        class="posture-seg"
        :data-tone="segment.tone"
        :style="{ flexGrow: segment.value / total }"
      />
    </div>

    <div class="posture-legend">
      <button
        v-for="segment in segments"
        :key="segment.label"
        class="posture-chip"
        type="button"
        :data-tone="segment.tone"
        :data-active="active === segment.key && segment.key !== 'all'"
        :disabled="!segment.value"
        :title="segment.hint"
        @click="emit('select', active === segment.key ? 'all' : segment.key)"
      >
        <span class="pill-dot" aria-hidden="true" />
        <strong>{{ segment.value }}</strong>
        <span>{{ segment.label }}</span>
      </button>
      <button
        class="posture-chip"
        type="button"
        data-tone="warn"
        :data-active="active === 'foreign_tables'"
        :disabled="!counts.withForeignTables"
        title="nftables tables present on the node that NetGuard did not write and does not manage"
        @click="emit('select', active === 'foreign_tables' ? 'all' : 'foreign_tables')"
      >
        <span class="pill-dot" aria-hidden="true" />
        <strong>{{ counts.withForeignTables }}</strong>
        <span>foreign tables</span>
      </button>
      <button
        class="posture-chip"
        type="button"
        data-tone="muted"
        :data-active="active === 'unmanaged'"
        :disabled="counts.total === counts.managed"
        title="nodes NetGuard observes but does not control"
        @click="emit('select', active === 'unmanaged' ? 'all' : 'unmanaged')"
      >
        <span class="pill-dot" aria-hidden="true" />
        <strong>{{ counts.total - counts.managed }}</strong>
        <span>not managed</span>
      </button>
    </div>
  </section>
</template>
