<script setup lang="ts">
/**
 * The open ports nothing explains, one row each, under the table.
 *
 * A row is a sentence the operator can act on: the node, the port and its
 * owner, then on expansion the server's own suggestion for it (the same
 * `review` the node detail reads) and what to do. "Add to group" opens the
 * group editor pre-filled with the rule the finding proposes; "Ignore" hides
 * the row for this session only, and says so, because a dismissal that
 * silently persisted would be a firewall finding nobody sees again.
 */
import { ChevronRight, LoaderCircle } from "@lucide/vue";

import { formatProcesses, type Finding } from "../exposure";
import { suggestionsByPort, type GuardSuggestion, type Review } from "../netguardModel";

const props = defineProps<{
  findings: readonly Finding[];
  expanded: ReadonlySet<string>;
  reviews: ReadonlyMap<string, Review>;
  reviewLoading: ReadonlySet<string>;
  reviewErrors: ReadonlyMap<string, string>;
  canAdmin: boolean;
}>();

const emit = defineEmits<{
  (event: "toggle", key: string): void;
  (event: "add", finding: Finding): void;
  (event: "ignore", key: string): void;
}>();

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
  <section v-if="findings.length" class="findings-list" aria-label="Open ports nothing explains">
    <header class="findings-head">
      <h2>Open and unexplained</h2>
      <p class="subtle">{{ findings.length }} {{ findings.length === 1 ? 'port' : 'ports' }} the internet can reach with no rule saying so.</p>
    </header>
    <article
      v-for="finding in findings"
      :id="`finding-${finding.key}`"
      :key="finding.key"
      class="finding-row"
      :data-open="expanded.has(finding.key)"
    >
      <button
        class="finding-toggle"
        type="button"
        :aria-expanded="expanded.has(finding.key)"
        :aria-controls="`finding-body-${finding.key}`"
        @click="emit('toggle', finding.key)"
      >
        <ChevronRight class="finding-chevron" :size="14" aria-hidden="true" />
        <span class="finding-text"><strong>{{ finding.nodeName }}</strong>: {{ finding.sentence }}</span>
      </button>
      <div class="finding-actions">
        <button v-if="canAdmin" class="button secondary compact" type="button" @click="emit('add', finding)">Add to group</button>
        <button
          class="button ghost compact"
          type="button"
          title="Hides this finding until the page is reloaded. Nothing is saved and no node changes."
          @click="emit('ignore', finding.key)"
        >
          Ignore
        </button>
      </div>
      <div :id="`finding-body-${finding.key}`" class="finding-body" :aria-hidden="!expanded.has(finding.key)">
        <div class="finding-body-inner">
          <p>{{ finding.hint }}</p>
          <dl class="finding-facts">
            <dt>Owner</dt>
            <dd class="mono">{{ formatProcesses(finding.span) || 'unknown (the agent could not read the process)' }}</dd>
            <dt>Protocol</dt>
            <dd class="mono">{{ finding.span.protocol }}</dd>
          </dl>
          <p v-if="reviewLoading.has(finding.nodeId)" class="subtle finding-review">
            <LoaderCircle class="spin" :size="13" />Reading this node's review
          </p>
          <p v-else-if="reviewErrors.get(finding.nodeId)" class="warn-text finding-review">
            The server's review could not be read: {{ reviewErrors.get(finding.nodeId) }}
          </p>
          <template v-else-if="reviews.has(finding.nodeId)">
            <p v-for="suggestion in serverSuggestions(finding)" :key="suggestion.id" class="finding-review">
              <strong>{{ suggestion.title }}.</strong> {{ suggestion.detail }}
            </p>
            <p v-if="!serverSuggestions(finding).length" class="subtle finding-review">
              The server's review has no suggestion for this port, which is expected where nothing enforces rules yet.
            </p>
          </template>
        </div>
      </div>
    </article>
  </section>
</template>
