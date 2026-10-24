<script setup lang="ts">
/**
 * Security groups as group rows, with their ordered rules folded underneath.
 *
 * The group row carries the facts the list is scanned for: the name, how many
 * rules, what the merged rules let in, and how many nodes use it. A click on
 * the row folds its rules open; Edit and Delete live in the row's one menu.
 * The id prints under the name only where it says something the name does
 * not, and a legacy baseline is the only source that earns a chip. The rules
 * print only while the group is open, one child row each, with the action as
 * a kind chip and the rule as a sentence in mono. Order is meaning in
 * nftables, so the rows are numbered and never re-sorted.
 */
import {
  PcActionsCell,
  PcGroupRow,
  PcKindChip,
  PcNameCell,
  PcRow,
  PcTable,
  PcTd,
  PcTh,
} from "@latticenet/plugin-bridge/chassis";

import { allowsPreview, ruleSentence, usedByNodes, type ExposureContext } from "../exposure";
import type { GuardNode, GuardRule, SecurityGroup } from "../netguardModel";
import { deleteBlockedReason, usedByLabel as usedByText } from "../nodeGroups";
import type { MenuItem } from "../rowMenu";
import RowMenu from "./RowMenu.vue";

const props = defineProps<{
  groups: readonly SecurityGroup[];
  nodes: readonly GuardNode[];
  context: ExposureContext;
  isOpen: (groupId: string) => boolean;
  canAdmin: boolean;
  /** The node groups that bind each security group, by id (design 32 S4). */
  nodeGroupsBy?: ReadonlyMap<string, readonly string[]>;
  /** True while the node-group read failed, so Used by may leave some out. */
  nodeGroupsUnknown?: boolean;
}>();

const emit = defineEmits<{
  (event: "toggle", groupId: string): void;
  (event: "edit", group: SecurityGroup): void;
  (event: "delete", group: SecurityGroup): void;
}>();

const COLUMNS = 4;

/** Delete is refused by NetGuard while a node or a node group binds the group, so the menu says so first. */
function menu(group: SecurityGroup): MenuItem[] {
  const blocked = deleteBlockedReason(usedBy(group), throughOf(group));
  return [
    { key: "edit", label: "Edit rules" },
    { key: "delete", label: "Delete group", danger: true, disabled: Boolean(blocked), reason: blocked },
  ];
}

function onMenu(key: string, group: SecurityGroup): void {
  if (key === "edit") emit("edit", group);
  else if (key === "delete") emit("delete", group);
}

/** "v4", or "legacy:cd-nas · v1" when the id says something the name does not. */
function subline(group: SecurityGroup): string {
  const version = `v${group.version}`;
  return group.id && group.id !== group.name ? `${group.id} · ${version}` : version;
}

/** A click on the row (not on its menu or its chevron) folds the rules, like the chevron does. */
function onRowClick(event: MouseEvent, group: SecurityGroup): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a, input")) return;
  emit("toggle", group.id);
}

function rulesWord(count: number): string {
  return count === 1 ? "1 rule" : `${count} rules`;
}

function usedBy(group: SecurityGroup): number {
  return usedByNodes(props.nodes, "group_ids", group.id);
}

function throughOf(group: SecurityGroup): readonly string[] {
  return props.nodeGroupsBy?.get(group.id) ?? [];
}

/** "3 nodes", "3 nodes · node group web", "1 node · 2 node groups". */
function usedByLabel(group: SecurityGroup): string {
  return usedByText(usedBy(group), throughOf(group), props.nodeGroupsUnknown);
}

/** The cell's title names every node group the label counts. */
function usedByTitle(group: SecurityGroup): string {
  const through = throughOf(group);
  const nodes = usedBy(group) === 1 ? "1 node" : `${usedBy(group)} nodes`;
  const lead = `Attached to ${nodes}`;
  if (!through.length) return props.nodeGroupsUnknown ? `${lead}; node groups were not read` : lead;
  return `${lead} and bound to ${through.length === 1 ? "node group" : "node groups"} ${through.join(", ")}`;
}

/** The merged preview, only where merging says something the rule list does not. */
function preview(group: SecurityGroup): string[] {
  const rules = group.rules ?? [];
  const merged = allowsPreview(rules, props.context);
  const enabledAllows = rules.filter((rule) => !rule.disabled && rule.action === "allow" && rule.direction === "ingress").length;
  return merged.length < enabledAllows ? merged : [];
}

/** "3 rules · allows TCP 22 from anywhere and TCP 443 from anywhere" */
function summary(group: SecurityGroup): string {
  const count = group.rules?.length ?? 0;
  if (!count) return "no rules, everything stays dropped";
  const lines = preview(group);
  return lines.length ? `${rulesWord(count)} · allows ${lines.join("; ")}` : rulesWord(count);
}

function actionLabel(rule: GuardRule): string {
  return rule.disabled ? "off" : rule.action;
}

function firstRuleId(group: SecurityGroup): string {
  return `rule-${group.id}-0`;
}
</script>

<template>
  <PcTable :min-width="720" :stacked="false" label="Security groups">
    <template #head>
      <PcTh name>Group / rule</PcTh>
      <PcTh>Rules</PcTh>
      <PcTh numeric>Used by</PcTh>
      <PcTh v-if="canAdmin" actions><span class="pc-sr-only">Actions</span></PcTh>
    </template>

    <tbody v-for="group in groups" :key="group.id" :data-open="isOpen(group.id) ? 'true' : undefined">
      <PcGroupRow :id="`group-${group.id}`" class="ng-click-row" :expanded="isOpen(group.id)" @click="onRowClick($event, group)">
        <PcNameCell
          :name="group.name"
          :sub="subline(group)"
          :title="group.description || group.name"
          :expanded="isOpen(group.id)"
          :controls="group.rules?.length ? firstRuleId(group) : undefined"
          @toggle="emit('toggle', group.id)"
        >
          <template #after>
            <PcKindChip v-if="group.source === 'legacy'" tone="info" label="legacy baseline" title="Imported from the node's pre-NetGuard rules; observe only until adopted" />
          </template>
        </PcNameCell>
        <PcTd label="Rules" stack="summary" :title="summary(group)">
          <span class="pc-group-summary">{{ summary(group) }}</span>
        </PcTd>
        <PcTd label="Used by" numeric :title="usedByTitle(group)">{{ usedByLabel(group) }}</PcTd>
        <PcActionsCell v-if="canAdmin">
          <RowMenu :label="`Actions for ${group.name}`" :items="menu(group)" @select="(key) => onMenu(key, group)" />
        </PcActionsCell>
      </PcGroupRow>

      <template v-if="isOpen(group.id)">
        <PcRow v-if="!group.rules?.length">
          <td class="pc-name" data-level="1" data-stack="name">
            <span class="ng-absent">No rules. Everything stays dropped.</span>
          </td>
          <PcTd :colspan="canAdmin ? COLUMNS - 2 : COLUMNS - 1" stack="summary" />
          <PcActionsCell v-if="canAdmin" />
        </PcRow>
        <PcRow v-for="(rule, index) in group.rules ?? []" :id="index === 0 ? firstRuleId(group) : undefined" :key="rule.id">
          <td class="pc-name ng-rule" data-level="1" data-stack="name" :data-disabled="rule.disabled ? 'true' : undefined">
            <span class="ng-rule-line">
              <span class="ng-rule-index pc-mono">{{ index + 1 }}</span>
              <PcKindChip :label="actionLabel(rule)" :title="rule.disabled ? 'Disabled: this rule is not compiled' : `Rule ${index + 1}, ${rule.action} ${rule.direction}`" />
              <span class="pc-mono ng-rule-sentence" :title="ruleSentence(rule, context)">{{ ruleSentence(rule, context) }}</span>
            </span>
            <small v-if="rule.comment" :title="rule.comment">{{ rule.comment }}</small>
          </td>
          <PcTd :colspan="canAdmin ? COLUMNS - 2 : COLUMNS - 1" stack="summary" />
          <PcActionsCell v-if="canAdmin" />
        </PcRow>
      </template>
    </tbody>
  </PcTable>
</template>
