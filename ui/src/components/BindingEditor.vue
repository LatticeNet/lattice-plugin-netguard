<script setup lang="ts">
/**
 * What a node's firewall is composed of: trusted zones, then attached groups.
 * The managed toggle is the authority switch, and turning it off is what makes
 * a node observe-only rather than deleting its policy.
 */
import { reactive, watch } from "vue";

import AnchoredOverlay from "./AnchoredOverlay.vue";
import type { GuardNode, GuardZone, SecurityGroup } from "../netguardModel";

const props = defineProps<{
  open: boolean;
  anchorTop: number;
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
  <AnchoredOverlay
    :open="open"
    :anchor-top="anchorTop"
    :busy="saving"
    :title="`Binding for ${node?.node_name || node?.node_id || 'node'}`"
    subtitle="Zones are accepted first, then attached security groups, then the default drop."
    @close="emit('close')"
  >
    <label class="managed-toggle">
      <input v-model="form.managed" type="checkbox" />
      <span>
        <strong>NetGuard controls this node's firewall</strong>
        <small>
          Turned off, the node stays visible and keeps reporting, but no plan can be compiled or
          applied for it. Its existing rules are left alone.
        </small>
      </span>
    </label>

    <div class="binding-grid">
      <fieldset>
        <legend>Security groups</legend>
        <p v-if="!groups.length" class="subtle">No groups exist yet.</p>
        <label v-for="group in groups" :key="group.id" class="check">
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
        <label v-for="zone in zones" :key="zone.id" class="check">
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

    <p v-if="error" class="notice danger"><span>{{ error }}</span></p>

    <template #footer>
      <button class="button secondary" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="button primary" type="button" :disabled="saving" @click="submit">Save binding</button>
    </template>
  </AnchoredOverlay>
</template>
