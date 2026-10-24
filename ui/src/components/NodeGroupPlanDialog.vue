<script setup lang="ts">
/**
 * The batch plan for a node group's binding (design 32 D3): one approval per
 * managed member whose table changes, each named with what it adds or
 * removes and the order its groups compile in. Planning applies nothing:
 * every node keeps its rules until its own approval is approved, and the
 * dialog says so before and after. A member NetGuard does not manage is
 * listed as not managed and gets no plan, since a binding never adopts.
 *
 * Neither the scrim nor Escape closes the dialog while the plan is in
 * flight, so a half-made batch cannot lose its answer.
 */
import { computed } from "vue";

import { PcButton, PcKindChip, PcModal, PcNotice, PcStatePill } from "@latticenet/plugin-bridge/chassis";

import type { NodeGroupBinding, NodeGroupPlanResult } from "../netguardModel";
import { membersLine, planFollowUp, planGroupLabel, planHeadline } from "../nodeGroups";

const props = defineProps<{
  open: boolean;
  binding?: NodeGroupBinding;
  planning: boolean;
  error: string;
  result?: NodeGroupPlanResult;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm"): void;
}>();

const groupLabel = computed(() => props.binding?.group_name || props.binding?.group_id || "node group");
const title = computed(() => (props.result ? `Plan for node group ${groupLabel.value}` : `Plan the members of node group ${groupLabel.value}`));
const description = computed(() =>
  props.result
    ? planHeadline(props.result)
    : "This creates one approval for each managed member whose firewall would change, including members that left the group. Nothing is sent to any node until its approval is approved.",
);

function nodeLabel(entry: { node_id: string; node_name?: string }): string {
  return entry.node_name || entry.node_id;
}

function close(): void {
  if (!props.planning) emit("close");
}
</script>

<template>
  <PcModal :open="open" :title="title" :description="description" size="large" @close="close">
    <div class="ng-stack">
      <template v-if="!result">
        <p v-if="binding">{{ membersLine(binding) }} now. Members it does not manage are listed afterwards and get no plan.</p>
        <PcNotice v-if="error"><p>{{ error }}</p></PcNotice>
      </template>

      <template v-else>
        <p v-if="planFollowUp(result)" class="ng-subtle">{{ planFollowUp(result) }}</p>

        <section v-if="result.affected.length" class="ng-subpanel" aria-labelledby="ng-plan-affected">
          <header class="ng-subpanel-head"><h3 id="ng-plan-affected">Planned</h3></header>
          <ul class="ng-plan-list">
            <li v-for="node in result.affected" :key="node.node_id" class="ng-plan-item">
              <div class="ng-plan-head">
                <strong>{{ nodeLabel(node) }}</strong>
                <span v-if="node.approval_id" class="pc-mono ng-subtle" :title="`Approval ${node.approval_id}`">{{ node.approval_id }}</span>
              </div>
              <p>{{ node.change }}</p>
              <ol class="ng-order-line" :aria-label="`Compile order on ${nodeLabel(node)}`">
                <li v-for="(group, index) in node.order" :key="`${group.id}-${index}`">
                  <span class="ng-rule-index pc-mono">{{ index + 1 }}</span>{{ planGroupLabel(group) }}
                </li>
              </ol>
              <p v-for="finding in node.findings ?? []" :key="finding.code" class="ng-subtle">{{ finding.code }}: {{ finding.message }}</p>
            </li>
          </ul>
        </section>

        <section v-if="result.conflicts.length" class="ng-subpanel" aria-labelledby="ng-plan-conflicts">
          <header class="ng-subpanel-head"><h3 id="ng-plan-conflicts">Could not plan</h3></header>
          <ul class="ng-plan-list">
            <li v-for="node in result.conflicts" :key="node.node_id" class="ng-plan-item">
              <div class="ng-plan-head"><strong>{{ nodeLabel(node) }}</strong><PcStatePill tone="error" label="not planned" /></div>
              <p>{{ node.reason }}</p>
              <p v-for="finding in node.findings ?? []" :key="finding.code" class="ng-subtle">{{ finding.code }}: {{ finding.message }}</p>
            </li>
          </ul>
          <p class="ng-subtle">A node blocked by the lockout lint can be planned on its own from its panel, where the risk can be reviewed and accepted.</p>
        </section>

        <section v-if="result.inactive.length" class="ng-subpanel" aria-labelledby="ng-plan-inactive">
          <header class="ng-subpanel-head"><h3 id="ng-plan-inactive">Not managed by NetGuard</h3></header>
          <ul class="ng-plan-list">
            <li v-for="node in result.inactive" :key="node.node_id" class="ng-plan-item">
              <div class="ng-plan-head"><strong>{{ nodeLabel(node) }}</strong><PcKindChip tone="info" label="inactive" /></div>
              <p>Group binding inactive: the node is not managed, so the binding does nothing there. Adopt the node to apply it.</p>
            </li>
          </ul>
        </section>

        <section v-if="result.unchanged.length" class="ng-subpanel" aria-labelledby="ng-plan-unchanged">
          <header class="ng-subpanel-head"><h3 id="ng-plan-unchanged">Already in force</h3></header>
          <p class="ng-subpanel-body">{{ result.unchanged.map(nodeLabel).join(", ") }}</p>
        </section>
      </template>
    </div>

    <template #footer>
      <template v-if="!result">
        <PcButton :disabled="planning" @click="close">Cancel</PcButton>
        <PcButton variant="primary" :busy="planning" @click="emit('confirm')">Create approvals</PcButton>
      </template>
      <PcButton v-else variant="primary" @click="close">Done</PcButton>
    </template>
  </PcModal>
</template>
