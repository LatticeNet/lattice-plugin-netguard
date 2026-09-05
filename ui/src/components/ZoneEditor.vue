<script setup lang="ts">
/**
 * Trusted zones: interfaces and CIDRs accepted before group evaluation.
 * A zone is the safest way to keep a management path open, so the copy says so.
 */
import { reactive, ref, watch } from "vue";

import { PcButton, PcModal, PcNotice } from "@latticenet/plugin-bridge/chassis";

import type { GuardZone } from "../netguardModel";

const props = defineProps<{
  open: boolean;
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

function close(): void {
  if (!props.saving) emit("close");
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
  <PcModal
    :open="open"
    :title="zone ? `Edit ${zone.name}` : 'New trusted zone'"
    description="Traffic arriving on a trusted interface or from a trusted CIDR is accepted before any security group is evaluated."
    @close="close"
  >
    <div class="ng-stack">
      <div class="ng-form-grid">
        <label class="ng-field">
          <span>Identifier</span>
          <input v-model="form.id" type="text" :disabled="Boolean(zone)" placeholder="office-vpn" />
        </label>
        <label class="ng-field">
          <span>Name</span>
          <input v-model="form.name" type="text" placeholder="Office VPN" />
        </label>
        <label class="ng-field ng-span-2">
          <span>Description</span>
          <input v-model="form.description" type="text" />
        </label>
        <label class="ng-field">
          <span>Interfaces</span>
          <input v-model="form.interfaces" type="text" placeholder="wg0, tailscale0" />
        </label>
        <label class="ng-field">
          <span>CIDRs</span>
          <input v-model="form.cidrs" type="text" placeholder="10.8.0.0/24" />
        </label>
      </div>
      <PcNotice v-if="localError || error"><p>{{ localError || error }}</p></PcNotice>
    </div>

    <template #footer>
      <PcButton :disabled="saving" @click="close">Cancel</PcButton>
      <PcButton variant="primary" :busy="saving" @click="submit">Save zone</PcButton>
    </template>
  </PcModal>
</template>
