<script setup lang="ts">
/**
 * The Attention lens: the open ports nothing explains, one row each, in the
 * attention-list form. It is a lens of its own, reached from the toolbar
 * with its count on the tab, because eleven things the page wants acted on
 * are not reachable when they sit under a 33 row table.
 *
 * A row is a sentence the operator can act on: the node, the port and its
 * owner, then on expansion the server's own suggestion for it (the same
 * `review` the node detail reads) and what to do. "Add to group" opens the
 * group editor pre-filled with the rule the finding proposes. "Ignore" hides
 * the detail for this session only: the row stays, says so in words on the
 * row itself, keeps counting, and offers Undo, because a firewall finding
 * that a click could make disappear for good is not a finding anyone sees
 * twice.
 *
 * The empty states are honest about why the list is empty: the session
 * cannot read reality, the snapshots are still streaming in, the search
 * matched nothing, or every open port on a fresh snapshot is allowed.
 */
import { computed } from "vue";
import { ChevronRight, LoaderCircle, ShieldCheck } from "@lucide/vue";

import { PcButton, PcCount, PcEmptyState, PcPanel, PcPanelHeader, PcStateDot } from "@latticenet/plugin-bridge/chassis";

import { formatProcesses, type Finding } from "../exposure";
import { suggestionsByPort, type GuardSuggestion, type Review } from "../netguardModel";

const props = defineProps<{
  /** Every unexplained span, ignored ones included. */
  findings: readonly Finding[];
  expanded: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
  reviews: ReadonlyMap<string, Review>;
  reviewLoading: ReadonlySet<string>;
  reviewErrors: ReadonlyMap<string, string>;
  canAdmin: boolean;
  canSeeReality: boolean;
  /** Snapshot reads still in flight, as "done of total"; findings land as each returns. */
  reading: { done: number; total: number };
  /** The toolbar search is narrowing the fleet the findings are drawn from. */
  searching: boolean;
  /** The nodes the findings were drawn from, after the search. */
  nodes: number;
}>();

const emit = defineEmits<{
  (event: "toggle", key: string): void;
  (event: "add", finding: Finding): void;
  (event: "ignore", key: string): void;
  (event: "restore", key: string): void;
}>();

const ignoredCount = computed(() => props.findings.filter((finding) => props.ignored.has(finding.key)).length);
const openCount = computed(() => props.findings.length - ignoredCount.value);
const countLabel = computed(() => `${openCount.value} open${ignoredCount.value ? ` · ${ignoredCount.value} ignored` : ""}`);
const stillReading = computed(() => props.reading.total > 0 && props.reading.done < props.reading.total);

const description = computed(() => {
  if (!props.findings.length) return "Open ports the internet can reach with no rule saying so, drawn from every fresh snapshot.";
  return `${openCount.value} ${openCount.value === 1 ? "port" : "ports"} the internet can reach with no rule saying so${ignoredCount.value ? `, ${ignoredCount.value} ignored for this session` : ""}.`;
});

/** The server's suggestions for the ports in this finding's span, if reviewed. */
function serverSuggestions(finding: Finding): GuardSuggestion[] {
  const review = props.reviews.get(finding.nodeId);
  if (!review) return [];
  const index = suggestionsByPort(review.suggestions ?? []);
  const out: GuardSuggestion[] = [];
  for (let port = finding.span.from; port <= finding.span.to; port++) {
    for (const suggestion of index.get(port) ?? []) {
      if (!suggestion.protocol || suggestion.protocol === finding.span.protocol) out.push(suggestion);
    }
  }
  return out;
}
</script>

<template>
  <PcPanel label="Open ports nothing explains">
    <PcPanelHeader title="Attention" :description="description">
      <PcCount v-if="findings.length" :value="countLabel" />
    </PcPanelHeader>

    <PcEmptyState v-if="!canSeeReality" kind="permission" title="Exposure cannot be read by this session">
      <p>Open ports are computed from each node's reported listeners, and this session has no scope to read node reality. Nothing here is known to be open or closed.</p>
    </PcEmptyState>
    <PcEmptyState v-else-if="!findings.length && stillReading" title="Still reading snapshots">
      <template #icon><LoaderCircle class="pc-spin" :size="26" /></template>
      <p>{{ reading.done }} of {{ reading.total }} snapshots read. A finding appears here as the node's snapshot lands.</p>
    </PcEmptyState>
    <PcEmptyState v-else-if="!findings.length && searching" kind="no-match" title="No finding matches that search">
      <p>No open port on {{ nodes }} matching {{ nodes === 1 ? 'node' : 'nodes' }} lacks a rule. The search covers node name and id, group and zone ids, group names, open ports and their owning process.</p>
    </PcEmptyState>
    <PcEmptyState v-else-if="!findings.length" title="Nothing unexplained">
      <template #icon><ShieldCheck :size="26" /></template>
      <p>Every port open to the internet on a fresh snapshot is allowed by a rule. Nodes whose snapshot is stale or that have never reported are not counted here; their rows on the Exposure lens say so.</p>
    </PcEmptyState>

    <div v-else class="ng-attn ng-attn-panel">
      <article
        v-for="finding in findings"
        :id="`finding-${finding.key}`"
        :key="finding.key"
        class="ng-attn-row"
        :data-open="expanded.has(finding.key) && !ignored.has(finding.key) ? 'true' : undefined"
        :data-ignored="ignored.has(finding.key) ? 'true' : undefined"
      >
        <template v-if="ignored.has(finding.key)">
          <PcStateDot tone="neutral" label="ignored" />
          <div class="ng-attn-claim">
            <span><strong>{{ finding.nodeName }}</strong>: {{ finding.sentence }}</span>
            <small>Ignored for this session only. Nothing is saved and no node changes.</small>
          </div>
          <div class="ng-attn-actions">
            <PcButton compact @click="emit('restore', finding.key)">Undo</PcButton>
          </div>
        </template>
        <template v-else>
          <PcStateDot tone="error" label="open" />
          <button
            class="ng-attn-toggle"
            type="button"
            :aria-expanded="expanded.has(finding.key) ? 'true' : 'false'"
            :aria-controls="`finding-body-${finding.key}`"
            @click="emit('toggle', finding.key)"
          >
            <ChevronRight class="ng-attn-chevron" :size="14" aria-hidden="true" />
            <span class="ng-attn-claim">
              <span><strong>{{ finding.nodeName }}</strong>: {{ finding.sentence }}</span>
            </span>
          </button>
          <div class="ng-attn-actions">
            <PcButton v-if="canAdmin" compact @click="emit('add', finding)">Add to group</PcButton>
            <span v-else class="ng-attn-readonly">read-only: netguard:admin is needed to add a rule</span>
            <PcButton compact @click="emit('ignore', finding.key)">Ignore</PcButton>
          </div>
          <div v-if="expanded.has(finding.key)" :id="`finding-body-${finding.key}`" class="ng-attn-body">
            <p>{{ finding.hint }}</p>
            <dl class="ng-kv ng-kv-inline">
              <dt>Owner</dt>
              <dd class="pc-mono">{{ formatProcesses(finding.span) || 'unknown (the agent could not read the process)' }}</dd>
              <dt>Protocol</dt>
              <dd class="pc-mono">{{ finding.span.protocol }}</dd>
            </dl>
            <p v-if="reviewLoading.has(finding.nodeId)" class="ng-subtle ng-attn-review">
              <LoaderCircle class="pc-spin" :size="13" />Reading this node's review
            </p>
            <p v-else-if="reviewErrors.get(finding.nodeId)" class="ng-warn-text ng-attn-review">
              The server's review could not be read: {{ reviewErrors.get(finding.nodeId) }}
            </p>
            <template v-else-if="reviews.has(finding.nodeId)">
              <p v-for="suggestion in serverSuggestions(finding)" :key="suggestion.id" class="ng-attn-review">
                <strong>{{ suggestion.title }}.</strong> {{ suggestion.detail }}
              </p>
              <p v-if="!serverSuggestions(finding).length" class="ng-subtle ng-attn-review">
                The server's review has no suggestion for this port, which is expected where nothing enforces rules yet.
              </p>
            </template>
            <p class="ng-subtle ng-attn-note">Ignore hides this row's detail for this session only; nothing is saved and no node changes.</p>
          </div>
        </template>
      </article>
    </div>
  </PcPanel>
</template>
