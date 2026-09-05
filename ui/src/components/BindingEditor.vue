<script setup lang="ts">
/**
 * What a node's firewall is composed of: trusted zones, then attached groups.
 * The managed toggle is the authority switch, and turning it off is what makes
 * a node observe-only rather than deleting its policy.
 */
import { reactive, watch } from "vue";

import { PcButton, PcModal, PcNotice } from "@latticenet/plugin-bridge/chassis";

import type { GuardNode, GuardZone, SecurityGroup } from "../netguardModel";

const props = defineProps<{
  open: boolean;
  node?: GuardNode;
  groups: readonly SecurityGroup[];
  zones: readonly GuardZone[];
  saving: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", payload: Record<string, unknown>): void;
}>();

const form = reactive<{ groups: string[]; zones: string[]; managed: boolean; version: number }>({
  groups: [],
  zones: [],
  managed: true,
  version: 0,
});

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen || !props.node) return;
    form.groups = [...(props.node.binding.group_ids ?? [])];
    form.zones = [...(props.node.binding.zone_ids ?? [])];
    form.managed = props.node.binding.managed;
    form.version = props.node.binding.version;
  },
  { immediate: true },
);

function toggle(list: string[], id: string, checked: boolean): void {
  const next = new Set(list);
  if (checked) next.add(id);
  else next.delete(id);
  list.splice(0, list.length, ...next);
}

function close(): void {
  if (!props.saving) emit("close");
}

function submit(): void {
  if (!props.node) return;
  emit("save", {
    node_id: props.node.node_id,
    group_ids: form.groups,
    zone_ids: form.zones,
    managed: form.managed,
    version: form.version,
    overrides: props.node.binding.overrides ?? [],
  });
}
</script>

<template>
  <PcModal
    :open="open"
    :title="`Binding for ${node?.node_name || node?.node_id || 'node'}`"
    description="Zones are accepted first, then attached security groups, then the default drop."
    @close="close"
  >
    <div class="ng-stack">
      <label class="ng-check ng-managed">
        <input v-model="form.managed" type="checkbox" />
        <span>
          <strong>NetGuard controls this node's firewall</strong>
          <small>
            Turned off, the node stays visible and keeps reporting, but no plan can be compiled or
            applied for it. Its existing rules are left alone.
          </small>
        </span>
      </label>

      <div class="ng-binding-grid">
        <fieldset>
          <legend>Security groups</legend>
          <p v-if="!groups.length" class="ng-subtle">
            No security groups exist yet. Create one on the Groups tab, then attach it here.
          </p>
          <label v-for="group in groups" :key="group.id" class="ng-check">
            <input
              type="checkbox"
              :checked="form.groups.includes(group.id)"
              @change="toggle(form.groups, group.id, ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>{{ group.name }}</strong>
              <small>{{ group.rules?.length ?? 0 }} rules</small>
            </span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Trusted zones</legend>
          <p v-if="!zones.length" class="ng-subtle">
            No zones exist yet. Create one on the Zones tab to keep a management path open.
          </p>
          <label v-for="zone in zones" :key="zone.id" class="ng-check">
            <input
              type="checkbox"
              :checked="form.zones.includes(zone.id)"
              @change="toggle(form.zones, zone.id, ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>{{ zone.name }}</strong>
              <small>{{ zone.builtin ? 'built in, resolved per node' : (zone.interfaces ?? []).join(', ') || 'no interfaces' }}</small>
            </span>
          </label>
        </fieldset>
      </div>

      <PcNotice v-if="error"><p>{{ error }}</p></PcNotice>
    </div>

    <template #footer>
      <PcButton :disabled="saving" @click="close">Cancel</PcButton>
      <PcButton variant="primary" :busy="saving" @click="submit">Save binding</PcButton>
    </template>
  </PcModal>
</template>
