<script setup lang="ts">
/**
 * The open ports nothing explains, one row each, in the attention-list form
 * under the exposure card.
 *
 * A row is a sentence the operator can act on: the node, the port and its
 * owner, then on expansion the server's own suggestion for it (the same
 * `review` the node detail reads) and what to do. "Add to group" opens the
 * group editor pre-filled with the rule the finding proposes. "Ignore" hides
 * the detail for this session only: the row stays, says so in words on the
 * row itself, keeps counting, and offers Undo, because a firewall finding
 * that a click could make disappear for good is not a finding anyone sees
 * twice.
 */
import { computed } from "vue";
import { ChevronRight, LoaderCircle } from "@lucide/vue";

import { PcButton, PcCount, PcPanel, PcPanelHeader, PcStateDot } from "@latticenet/plugin-bridge/chassis";

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
  <PcPanel v-if="findings.length" label="Open ports nothing explains">
    <PcPanelHeader
      title="Findings"
      :description="`${openCount} ${openCount === 1 ? 'port' : 'ports'} the internet can reach with no rule saying so${ignoredCount ? `, ${ignoredCount} ignored for this session` : ''}.`"
    >
      <PcCount :value="countLabel" />
    </PcPanelHeader>

    <div class="ng-attn ng-attn-panel">
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
