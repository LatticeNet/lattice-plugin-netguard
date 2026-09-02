<script setup lang="ts">
/**
 * The open ports nothing explains, one row each, under the table.
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
      <p class="subtle">
        {{ openCount }} {{ openCount === 1 ? 'port' : 'ports' }} the internet can reach with no rule saying so<template v-if="ignoredCount">, {{ ignoredCount }} ignored for this session</template>.
      </p>
    </header>
    <article
      v-for="finding in findings"
      :id="`finding-${finding.key}`"
      :key="finding.key"
      class="finding-row"
      :data-open="expanded.has(finding.key) && !ignored.has(finding.key)"
      :data-ignored="ignored.has(finding.key)"
    >
      <template v-if="ignored.has(finding.key)">
        <div class="finding-toggle finding-static">
          <span class="finding-text"><strong>{{ finding.nodeName }}</strong>: {{ finding.sentence }}</span>
          <span class="finding-ignored">Ignored for this session only. Nothing is saved and no node changes.</span>
        </div>
        <div class="finding-actions">
          <button class="button secondary compact" type="button" @click="emit('restore', finding.key)">Undo</button>
        </div>
      </template>
      <template v-else>
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
          <span v-else class="finding-readonly">read-only: netguard:admin is needed to add a rule</span>
          <button class="button ghost compact" type="button" @click="emit('ignore', finding.key)">Ignore</button>
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
            <p class="subtle finding-note">Ignore hides this row's detail for this session only; nothing is saved and no node changes.</p>
          </div>
        </div>
      </template>
    </article>
  </section>
</template>
