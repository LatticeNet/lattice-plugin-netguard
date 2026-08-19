<script setup lang="ts">
/**
 * Trusted zones: interfaces and CIDRs accepted before group evaluation.
 * A zone is the safest way to keep a management path open, so the copy says so.
 */
import { reactive, ref, watch } from "vue";

import AnchoredOverlay from "./AnchoredOverlay.vue";
import type { GuardZone } from "../netguardModel";

const props = defineProps<{
  open: boolean;
  anchorTop: number;
  zone?: GuardZone;
  saving: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", payload: Record<string, unknown>): void;
}>();

const form = reactive({ id: "", name: "", description: "", interfaces: "", cidrs: "" });
const localError = ref("");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    localError.value = "";
    Object.assign(form, {
      id: props.zone?.id ?? "",
      name: props.zone?.name ?? "",
      description: props.zone?.description ?? "",
      interfaces: (props.zone?.interfaces ?? []).join(", "),
      cidrs: (props.zone?.cidrs ?? []).join(", "),
    });
  },
  { immediate: true },
);

function splitList(value: string): string[] {
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

function submit(): void {
  localError.value = "";
  if (!form.id.trim() || !form.name.trim()) {
    localError.value = "A zone needs both an identifier and a name.";
    return;
  }
  emit("save", {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    interfaces: splitList(form.interfaces),
    cidrs: splitList(form.cidrs),
  });
}
</script>

<template>
  <AnchoredOverlay
    :open="open"
    :anchor-top="anchorTop"
    :busy="saving"
    :title="zone ? `Edit ${zone.name}` : 'New trusted zone'"
    subtitle="Traffic arriving on a trusted interface or from a trusted CIDR is accepted before any security group is evaluated."
    @close="emit('close')"
  >
    <div class="form-grid">
      <label class="field">
        <span>Identifier</span>
        <input v-model="form.id" type="text" :disabled="Boolean(zone)" placeholder="office-vpn" />
      </label>
      <label class="field">
        <span>Name</span>
        <input v-model="form.name" type="text" placeholder="Office VPN" />
      </label>
      <label class="field span-2">
        <span>Description</span>
        <input v-model="form.description" type="text" />
      </label>
      <label class="field">
        <span>Interfaces</span>
        <input v-model="form.interfaces" type="text" placeholder="wg0, tailscale0" />
      </label>
      <label class="field">
        <span>CIDRs</span>
        <input v-model="form.cidrs" type="text" placeholder="10.8.0.0/24" />
      </label>
    </div>
    <p v-if="localError || error" class="notice danger"><span>{{ localError || error }}</span></p>

    <template #footer>
      <button class="button secondary" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="button primary" type="button" :disabled="saving" @click="submit">Save zone</button>
    </template>
  </AnchoredOverlay>
</template>
