<script setup lang="ts">
/**
 * Trusted zones as flat rows. A built-in zone is resolved per node and carries
 * the kind chip in place of actions; a custom zone can be edited or deleted.
 */
import { Pencil, Trash2 } from "@lucide/vue";

import { PcActionsCell, PcIconButton, PcKindChip, PcNameCell, PcRow, PcTable, PcTd, PcTh } from "@latticenet/plugin-bridge/chassis";

import { usedByNodes } from "../exposure";
import type { GuardNode, GuardZone } from "../netguardModel";

const props = defineProps<{
  zones: readonly GuardZone[];
  nodes: readonly GuardNode[];
  canAdmin: boolean;
}>();

const emit = defineEmits<{
  (event: "edit", zone: GuardZone): void;
  (event: "delete", zone: GuardZone): void;
}>();

function nodesWord(count: number): string {
  return count === 1 ? "1 node" : `${count} nodes`;
}

function usedBy(zone: GuardZone): number {
  return usedByNodes(props.nodes, "zone_ids", zone.id);
}

function listOr(values: readonly string[] | undefined, zone: GuardZone): string {
  return values?.join(", ") || (zone.builtin ? "resolved per node" : "none set");
}
</script>

<template>
  <PcTable :min-width="880" label="Trusted zones">
    <template #head>
      <PcTh name>Zone</PcTh>
      <PcTh>Interfaces</PcTh>
      <PcTh>CIDRs</PcTh>
      <PcTh>Kind</PcTh>
      <PcTh numeric>Used by</PcTh>
      <PcTh actions>Actions</PcTh>
    </template>

    <tbody>
      <PcRow v-for="zone in zones" :id="`zone-${zone.id}`" :key="zone.id">
        <PcNameCell :name="zone.name" :id="zone.id" :sub="zone.description || zone.id" :title="zone.description || zone.name" />
        <PcTd label="Interfaces" mono :title="listOr(zone.interfaces, zone)">
          <span :class="zone.interfaces?.length ? undefined : 'ng-absent'">{{ listOr(zone.interfaces, zone) }}</span>
        </PcTd>
        <PcTd label="CIDRs" mono :title="listOr(zone.cidrs, zone)">
          <span :class="zone.cidrs?.length ? undefined : 'ng-absent'">{{ listOr(zone.cidrs, zone) }}</span>
        </PcTd>
        <PcTd label="Kind" stack="state">
          <PcKindChip v-if="zone.builtin" tone="info" label="built in" title="Defined by NetGuard and resolved on every node; it cannot be edited or deleted" />
          <PcKindChip v-else label="custom" />
        </PcTd>
        <PcTd label="Used by" numeric :title="`Trusted by ${nodesWord(usedBy(zone))}`">{{ nodesWord(usedBy(zone)) }}</PcTd>
        <PcActionsCell>
          <template v-if="canAdmin && !zone.builtin">
            <PcIconButton bordered :label="`Edit ${zone.name}`" @click="emit('edit', zone)"><Pencil :size="14" /></PcIconButton>
            <PcIconButton bordered destructive :label="`Delete ${zone.name}`" @click="emit('delete', zone)"><Trash2 :size="14" /></PcIconButton>
          </template>
        </PcActionsCell>
      </PcRow>
    </tbody>
  </PcTable>
</template>
