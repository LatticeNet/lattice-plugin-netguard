<script setup lang="ts">
/**
 * Node groups and the security groups they bind (design 32 S4), one row per
 * node group. The security groups print numbered, in compile order, because
 * position is meaning; the members say how many compile them and how many
 * NetGuard does not manage, which is where a binding quietly does nothing.
 * Edit, plan and unbind live in the row's one menu.
 */
import { PcActionsCell, PcRow, PcTable, PcTd, PcTh } from "@latticenet/plugin-bridge/chassis";

import type { NodeGroupBinding, SecurityGroup } from "../netguardModel";
import { membersLine } from "../nodeGroups";
import type { MenuItem } from "../rowMenu";
import RowMenu from "./RowMenu.vue";

const props = defineProps<{
  bindings: readonly NodeGroupBinding[];
  groups: readonly SecurityGroup[];
  canAdmin: boolean;
  canPlan: boolean;
}>();

const emit = defineEmits<{
  (event: "edit", binding: NodeGroupBinding): void;
  (event: "plan", binding: NodeGroupBinding): void;
  (event: "unbind", binding: NodeGroupBinding): void;
}>();

function menu(binding: NodeGroupBinding): MenuItem[] {
  const items: MenuItem[] = [];
  if (props.canAdmin) items.push({ key: "edit", label: "Edit security groups" });
  if (props.canPlan) {
    const managed = binding.members.some((member) => member.state === "active");
    items.push({ key: "plan", label: "Plan its members", disabled: !managed, reason: managed ? undefined : "No member is managed by NetGuard" });
  }
  if (props.canAdmin) items.push({ key: "unbind", label: "Unbind node group", danger: true });
  return items;
}

function onMenu(key: string, binding: NodeGroupBinding): void {
  if (key === "edit") emit("edit", binding);
  else if (key === "plan") emit("plan", binding);
  else if (key === "unbind") emit("unbind", binding);
}

function groupName(id: string): string {
  return props.groups.find((group) => group.id === id)?.name ?? id;
}

function inactiveTitle(binding: NodeGroupBinding): string {
  const names = binding.members.filter((member) => member.state === "inactive").map((member) => member.node_name || member.node_id);
  return names.length ? `Not managed by NetGuard, so the binding does nothing there: ${names.join(", ")}` : "Every member compiles these groups once planned";
}
</script>

<template>
  <PcTable class="ng-pinned-actions" :min-width="640" :stacked="false" label="Node groups bound to security groups">
    <template #head>
      <PcTh name>Node group</PcTh>
      <PcTh>Security groups, in order</PcTh>
      <PcTh>Members</PcTh>
      <PcTh v-if="canAdmin || canPlan" actions><span class="pc-sr-only">Actions</span></PcTh>
    </template>
    <tbody>
      <PcRow v-for="binding in bindings" :key="binding.group_id">
        <td class="pc-name" data-stack="name">
          <strong :title="binding.group_name || binding.group_id">{{ binding.group_name || binding.group_id }}</strong>
        </td>
        <PcTd label="Security groups" stack="summary">
          <span v-if="!binding.security_group_ids.length" class="ng-absent">None bound</span>
          <ol v-else class="ng-order-line">
            <li v-for="(id, index) in binding.security_group_ids" :key="id">
              <span class="ng-rule-index pc-mono">{{ index + 1 }}</span>{{ groupName(id) }}
            </li>
          </ol>
        </PcTd>
        <PcTd label="Members" :title="inactiveTitle(binding)">{{ membersLine(binding) }}</PcTd>
        <PcActionsCell v-if="canAdmin || canPlan">
          <RowMenu :label="`Actions for node group ${binding.group_name || binding.group_id}`" :items="menu(binding)" @select="(key) => onMenu(key, binding)" />
        </PcActionsCell>
      </PcRow>
    </tbody>
  </PcTable>
</template>
