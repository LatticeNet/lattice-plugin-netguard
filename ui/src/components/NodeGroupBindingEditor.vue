<script setup lang="ts">
/**
 * Which security groups a node group binds, in compile order (design 32 S4).
 * The list is ordered because nftables evaluates in order and one deny turns
 * the fast path off, so each row moves up and down instead of being a set of
 * checkboxes. Saving changes nothing on any node: the members get the groups
 * through the plan the operator makes next, and a member NetGuard does not
 * manage is never adopted by it.
 */
import { computed, reactive, watch } from "vue";
import { ArrowDown, ArrowUp, X } from "@lucide/vue";

import { PcButton, PcIconButton, PcModal, PcNotice } from "@latticenet/plugin-bridge/chassis";

import type { NodeGroupBinding, NodeGroupChoice, SecurityGroup } from "../netguardModel";
import { bindableGroups, moveItem, unboundNodeGroups } from "../nodeGroups";

const props = defineProps<{
  open: boolean;
  /** The binding being edited; a new one when absent. */
  binding?: NodeGroupBinding;
  bindings: readonly NodeGroupBinding[];
  nodeGroups: readonly NodeGroupChoice[];
  groups: readonly SecurityGroup[];
  saving: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", payload: Record<string, unknown>): void;
}>();

const form = reactive<{ groupId: string; ids: string[]; version: number; adding: string }>({ groupId: "", ids: [], version: 0, adding: "" });

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    form.groupId = props.binding?.group_id ?? "";
    form.ids = [...(props.binding?.security_group_ids ?? [])];
    form.version = props.binding?.version ?? 0;
    form.adding = "";
  },
  { immediate: true },
);

const choices = computed(() => unboundNodeGroups(props.nodeGroups, props.bindings));
const addable = computed(() => bindableGroups(props.groups, form.ids));
const chosenGroup = computed(() => props.nodeGroups.find((choice) => choice.id === form.groupId));
const title = computed(() => (props.binding ? `Security groups for node group ${props.binding.group_name || props.binding.group_id}` : "Bind security groups to a node group"));

function groupName(id: string): string {
  return props.groups.find((group) => group.id === id)?.name ?? id;
}

function membersWord(choice: NodeGroupChoice | undefined): string {
  const n = choice?.members.length ?? 0;
  return n === 1 ? "1 member" : `${n} members`;
}

function add(): void {
  if (form.adding && !form.ids.includes(form.adding)) form.ids.push(form.adding);
  form.adding = "";
}

function move(index: number, delta: -1 | 1): void {
  form.ids = moveItem(form.ids, index, delta);
}

function remove(index: number): void {
  form.ids.splice(index, 1);
}

function close(): void {
  if (!props.saving) emit("close");
}

function submit(): void {
  if (!form.groupId) return;
  emit("save", { group_id: form.groupId, security_group_ids: form.ids, version: form.version });
}
</script>

<template>
  <PcModal
    :open="open"
    :title="title"
    description="Members NetGuard manages compile these groups after their own, in this order, once a plan for them is approved. A member it does not manage is not adopted and gets nothing."
    @close="close"
  >
    <div class="ng-stack">
      <label v-if="!binding" class="ng-field">
        <span>Node group</span>
        <select v-model="form.groupId" :disabled="saving">
          <option value="" disabled>Choose a node group</option>
          <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.name }} ({{ membersWord(choice) }})</option>
        </select>
        <small v-if="!choices.length" class="ng-subtle">Every node group already has a binding. Edit one from the list instead.</small>
      </label>
      <p v-else class="ng-subtle">{{ membersWord(chosenGroup) }} in this node group now; membership is the node group's, edited under Fleet.</p>

      <fieldset class="ng-ordered">
        <legend>Security groups, in compile order</legend>
        <p v-if="!form.ids.length" class="ng-subtle">None. Saving an empty list unbinds the node group; its members lose the groups at their next plan.</p>
        <ol v-else class="ng-ordered-list">
          <li v-for="(id, index) in form.ids" :key="id" class="ng-ordered-item">
            <span class="ng-rule-index pc-mono">{{ index + 1 }}</span>
            <span class="ng-ordered-name">{{ groupName(id) }}</span>
            <span class="ng-ordered-actions">
              <PcIconButton bordered :label="`Move ${groupName(id)} up`" :disabled="saving || index === 0" @click="move(index, -1)"><ArrowUp :size="15" /></PcIconButton>
              <PcIconButton bordered :label="`Move ${groupName(id)} down`" :disabled="saving || index === form.ids.length - 1" @click="move(index, 1)"><ArrowDown :size="15" /></PcIconButton>
              <PcIconButton bordered destructive :label="`Remove ${groupName(id)}`" :disabled="saving" @click="remove(index)"><X :size="15" /></PcIconButton>
            </span>
          </li>
        </ol>
        <div class="ng-ordered-add">
          <label class="ng-field">
            <span>Add a security group</span>
            <select v-model="form.adding" :disabled="saving || !addable.length">
              <option value="">{{ addable.length ? "Choose a group" : "No other group to add" }}</option>
              <option v-for="group in addable" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <PcButton :disabled="saving || !form.adding" @click="add">Add</PcButton>
        </div>
      </fieldset>

      <PcNotice v-if="error"><p>{{ error }}</p></PcNotice>
    </div>

    <template #footer>
      <PcButton :disabled="saving" @click="close">Cancel</PcButton>
      <PcButton variant="primary" :busy="saving" :disabled="!form.groupId" @click="submit">Save binding</PcButton>
    </template>
  </PcModal>
</template>
