<script setup lang="ts">
/**
 * Security groups as group rows, with their ordered rules folded underneath.
 *
 * The group row carries the facts the list is scanned for: the name, how many
 * rules, what the merged rules let in, how many nodes use it, and where it
 * came from. The rules print only while the group is open, one child row each,
 * with the action as a kind chip and the rule as a sentence in mono. Order is
 * meaning in nftables, so the rows are numbered and never re-sorted.
 */
import { Pencil, Trash2 } from "@lucide/vue";

import {
  PcActionsCell,
  PcGroupRow,
  PcIconButton,
  PcKindChip,
  PcNameCell,
  PcRow,
  PcTable,
  PcTd,
  PcTh,
} from "@latticenet/plugin-bridge/chassis";

import { allowsPreview, ruleSentence, usedByNodes, type ExposureContext } from "../exposure";
import type { GuardNode, GuardRule, SecurityGroup } from "../netguardModel";

const props = defineProps<{
  groups: readonly SecurityGroup[];
  nodes: readonly GuardNode[];
  context: ExposureContext;
  isOpen: (groupId: string) => boolean;
  canAdmin: boolean;
}>();

const emit = defineEmits<{
  (event: "toggle", groupId: string): void;
  (event: "edit", group: SecurityGroup): void;
  (event: "delete", group: SecurityGroup): void;
}>();

const COLUMNS = 5;

function rulesWord(count: number): string {
  return count === 1 ? "1 rule" : `${count} rules`;
}

function nodesWord(count: number): string {
  return count === 1 ? "1 node" : `${count} nodes`;
}

function usedBy(group: SecurityGroup): number {
  return usedByNodes(props.nodes, "group_ids", group.id);
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
  <PcTable :min-width="880" label="Security groups">
    <template #head>
      <PcTh name>Group / rule</PcTh>
      <PcTh>Rules</PcTh>
      <PcTh numeric>Used by</PcTh>
      <PcTh>Source</PcTh>
      <PcTh actions>Actions</PcTh>
    </template>

    <tbody v-for="group in groups" :key="group.id" :data-open="isOpen(group.id) ? 'true' : undefined">
      <PcGroupRow :id="`group-${group.id}`" :expanded="isOpen(group.id)">
        <PcNameCell
          :name="group.name"
          :id="group.id"
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
        <PcTd label="Used by" numeric :title="`Attached to ${nodesWord(usedBy(group))}`">{{ nodesWord(usedBy(group)) }}</PcTd>
        <PcTd label="Source">{{ group.source || 'stored' }}<small>v{{ group.version }}</small></PcTd>
        <PcActionsCell>
          <template v-if="canAdmin">
            <PcIconButton bordered :label="`Edit ${group.name}`" @click="emit('edit', group)"><Pencil :size="14" /></PcIconButton>
            <PcIconButton bordered destructive :label="`Delete ${group.name}`" @click="emit('delete', group)"><Trash2 :size="14" /></PcIconButton>
          </template>
        </PcActionsCell>
      </PcGroupRow>

      <template v-if="isOpen(group.id)">
        <PcRow v-if="!group.rules?.length">
          <td class="pc-name" data-level="1" data-stack="name">
            <span class="ng-absent">No rules. Everything stays dropped.</span>
          </td>
          <PcTd :colspan="COLUMNS - 2" stack="summary" />
          <PcActionsCell />
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
          <PcTd :colspan="COLUMNS - 2" stack="summary" />
          <PcActionsCell />
        </PcRow>
      </template>
    </tbody>
  </PcTable>
</template>
