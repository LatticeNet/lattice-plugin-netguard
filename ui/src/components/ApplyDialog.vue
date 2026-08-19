<script setup lang="ts">
/**
 * The two-step gate in front of anything that can cut access.
 *
 * Step one is evidence: the lint findings, the change to the intended ruleset,
 * and the node this will touch by name. Step two is a deliberate, separate
 * confirmation that restates the node name and, when the plan would remove the
 * operator's own shell path, requires the lockout risk to be accepted
 * explicitly. The two steps exist because a single button next to a diff gets
 * pressed while reading the diff.
 */
import { computed, ref, watch } from "vue";
import { CircleAlert, LoaderCircle, ShieldAlert } from "@lucide/vue";

import AnchoredOverlay from "./AnchoredOverlay.vue";
import { collapseUnchanged, diffRulesets, summarizeDiff } from "../diff";
import type { PostureRow } from "../posture";
import type { LintFinding } from "../netguardModel";

const props = defineProps<{
  open: boolean;
  anchorTop: number;
  row?: PostureRow;
  /** The ruleset as it was when this node's detail was opened. */
  baseline: string;
  /** The ruleset the current intent compiles to. */
  ruleset: string;
  findings: readonly LintFinding[];
  compileError: string;
  planning: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm", acceptLockoutRisk: boolean): void;
}>();

const step = ref<1 | 2>(1);
const acceptLockoutRisk = ref(false);
const typedName = ref("");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    step.value = 1;
    acceptLockoutRisk.value = false;
    typedName.value = "";
  },
);

const diff = computed(() => diffRulesets(props.baseline, props.ruleset));
const collapsed = computed(() => collapseUnchanged(diff.value.lines, 3));
const summary = computed(() => summarizeDiff(diff.value));

const blocking = computed(() => props.findings.filter((finding) => finding.severity === "block"));
const warnings = computed(() => props.findings.filter((finding) => finding.severity !== "block"));

/** A drifted node's live table is not the baseline, and the diff must say so. */
const driftCaveat = computed(() => props.row?.driftState === "drift");

const nodeLabel = computed(() => props.row?.nodeName || props.row?.nodeId || "this node");

const confirmSatisfied = computed(() => {
  if (typedName.value.trim() !== nodeLabel.value.trim()) return false;
  if (blocking.value.length && !acceptLockoutRisk.value) return false;
  return true;
});

function advance(): void {
  step.value = 2;
}
</script>

<template>
  <AnchoredOverlay
    :open="open"
    :anchor-top="anchorTop"
    :busy="planning"
    width="wide"
    :title="step === 1 ? `Review the change to ${nodeLabel}` : `Confirm apply to ${nodeLabel}`"
    :subtitle="step === 1
      ? 'Nothing has been sent to the node yet. This creates an approval, which the apply pipeline then carries out.'
      : 'The next action creates an approval for this node.'"
    @close="emit('close')"
  >
    <template v-if="step === 1">
      <div v-if="compileError" class="notice danger">
        <CircleAlert :size="16" />
        <div>
          <strong>This node's intent does not compile</strong>
          <p>{{ compileError }}</p>
        </div>
      </div>

      <div v-for="finding in blocking" :key="finding.code" class="notice danger">
        <ShieldAlert :size="16" />
        <div>
          <strong>Blocking: {{ finding.code }}</strong>
          <p>{{ finding.message }}</p>
        </div>
      </div>
      <div v-for="finding in warnings" :key="finding.code" class="notice warn">
        <CircleAlert :size="16" />
        <div>
          <strong>{{ finding.code }}</strong>
          <p>{{ finding.message }}</p>
        </div>
      </div>

      <section class="subpanel">
        <header class="subpanel-head">
          <h3>Change to the intended ruleset</h3>
          <p>
            {{ summary }}. This compares the ruleset as it was when you opened this node against what
            it compiles to now.
          </p>
          <p v-if="driftCaveat" class="danger-text">
            This node has drifted, so its live table is not what Lattice last applied. These lines
            describe the change to Lattice's intent, not to the ruleset currently on the machine.
          </p>
          <p v-if="diff.truncated" class="warn-text">
            The ruleset was too large to diff line by line, so both versions are shown in full.
          </p>
        </header>
        <div v-if="diff.identical" class="subpanel-body subtle">
          The intended ruleset is unchanged. Applying re-installs the same rules, which is the way to
          bring a drifted node back into line.
        </div>
        <pre v-else class="code diff"><template v-for="(line, index) in collapsed" :key="index"><span
          v-if="line.kind === 'gap'" class="diff-gap">    {{ line.hidden }} unchanged {{ line.hidden === 1 ? 'line' : 'lines' }}
</span><span v-else class="diff-line" :data-kind="line.kind">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }} {{ line.text }}
</span></template></pre>
      </section>
    </template>

    <template v-else>
      <div class="confirm">
        <p>
          This creates an approval to install the ruleset above on
          <strong>{{ nodeLabel }}</strong>
          (<span class="mono">{{ row?.nodeId }}</span>). No other node is touched.
        </p>
        <p class="subtle">
          The node validates the candidate, snapshots its live ruleset, arms a 60 second dead-man
          watchdog, commits, then verifies it can still reach the control plane. That check is an
          outbound connection, so it does not prove your inbound shell path survived.
        </p>

        <div v-if="blocking.length" class="notice danger">
          <ShieldAlert :size="16" />
          <div>
            <strong>This plan removes the management path this node reports</strong>
            <p v-for="finding in blocking" :key="finding.code">{{ finding.message }}</p>
            <label class="check">
              <input v-model="acceptLockoutRisk" type="checkbox" />
              <span>
                I accept the lockout risk on {{ nodeLabel }}. This is recorded in the audit log
                against my account.
              </span>
            </label>
          </div>
        </div>

        <label class="field">
          <span>Type the node name to confirm: {{ nodeLabel }}</span>
          <input v-model="typedName" type="text" autocomplete="off" spellcheck="false" />
        </label>

        <div v-if="error" class="notice danger">
          <CircleAlert :size="16" /><span>{{ error }}</span>
        </div>
      </div>
    </template>

    <template #footer>
      <button class="button secondary" type="button" :disabled="planning" @click="emit('close')">
        Cancel
      </button>
      <button
        v-if="step === 1"
        class="button primary"
        type="button"
        :disabled="Boolean(compileError)"
        @click="advance"
      >
        Continue
      </button>
      <template v-else>
        <button class="button secondary" type="button" :disabled="planning" @click="step = 1">
          Back to the diff
        </button>
        <button
          class="button danger"
          type="button"
          :disabled="!confirmSatisfied || planning"
          @click="emit('confirm', acceptLockoutRisk)"
        >
          <LoaderCircle v-if="planning" class="spin" :size="14" />
          Create approval for {{ nodeLabel }}
        </button>
      </template>
    </template>
  </AnchoredOverlay>
</template>
