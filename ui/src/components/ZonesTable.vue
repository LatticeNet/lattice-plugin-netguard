<script setup lang="ts">
/**
 * Trusted zones as flat rows. A built-in zone is resolved per node and its
 * kind chip says so in place of a menu; a custom zone is edited or deleted
 * from its row's one menu.
 */
import { PcActionsCell, PcKindChip, PcNameCell, PcRow, PcTable, PcTd, PcTh } from "@latticenet/plugin-bridge/chassis";

import { LOOPBACK_ZONE, PUBLIC_ZONE, usedByNodes } from "../exposure";
import type { GuardNode, GuardZone } from "../netguardModel";
import type { MenuItem } from "../rowMenu";
import RowMenu from "./RowMenu.vue";

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

/**
 * Who trusts the zone, which for two built-ins is not a count of bindings:
 * the table accepts loopback on every node before any zone (`iif lo
 * accept`, lattice-server network/nft.go), and the compiler refuses to trust
 * the public zone wholesale (netguard/compile.go), so rules name it as a
 * source instead. Every other zone is trusted where a binding lists it.
 */
function trustedBy(zone: GuardZone): { text: string; title: string; quiet?: boolean } {
  if (zone.id === LOOPBACK_ZONE) return { text: "every node", title: "The table accepts loopback on every node, before any zone or rule." };
  if (zone.id === PUBLIC_ZONE) {
    return { text: "never trusted", title: "The public zone cannot be trusted wholesale; a rule names it as the source it allows.", quiet: true };
  }
  const count = nodesWord(usedBy(zone));
  return { text: count, title: `Trusted by ${count} through their binding` };
}

const MENU: MenuItem[] = [
  { key: "edit", label: "Edit zone" },
  { key: "delete", label: "Delete zone", danger: true },
];

function onMenu(key: string, zone: GuardZone): void {
  if (key === "edit") emit("edit", zone);
  else if (key === "delete") emit("delete", zone);
}

function listOr(values: readonly string[] | undefined, zone: GuardZone): string {
  return values?.join(", ") || (zone.builtin ? "resolved per node" : "none set");
}
</script>

<template>
  <PcTable :min-width="720" :stacked="false" label="Trusted zones">
    <template #head>
      <PcTh name>Zone</PcTh>
      <PcTh>Interfaces</PcTh>
      <PcTh>CIDRs</PcTh>
      <PcTh>Kind</PcTh>
      <PcTh numeric>Trusted by</PcTh>
      <PcTh v-if="canAdmin" actions><span class="pc-sr-only">Actions</span></PcTh>
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
          <PcKindChip v-if="zone.builtin" tone="info" label="built in" title="Defined by NetGuard and resolved on every node, which is not the same as trusted there; it cannot be edited or deleted" />
          <PcKindChip v-else label="custom" />
        </PcTd>
        <PcTd label="Trusted by" numeric :title="trustedBy(zone).title">
          <span :class="trustedBy(zone).quiet ? 'ng-absent' : undefined">{{ trustedBy(zone).text }}</span>
        </PcTd>
        <PcActionsCell v-if="canAdmin">
          <RowMenu v-if="!zone.builtin" :label="`Actions for ${zone.name}`" :items="MENU" @select="(key) => onMenu(key, zone)" />
        </PcActionsCell>
      </PcRow>
    </tbody>
  </PcTable>
</template>
