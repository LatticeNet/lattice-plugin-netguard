<script setup lang="ts" generic="T extends string">
/**
 * Which rows a collection shows: a segmented control in the toolbar's first
 * slot, drawn with the chassis's lens look, each option with its count. It
 * replaces a native select, which hid the attention count behind a click and
 * drew a browser control in the middle of the console's own.
 *
 * Semantics are a radio group, not a tablist: the options filter one panel
 * rather than switching between panels. Only the checked option is in the Tab
 * order; ArrowLeft, ArrowRight, Home and End move the choice and the focus.
 */
import { PcCount, type CountTone } from "@latticenet/plugin-bridge/chassis";

export interface FilterOption<V extends string> {
  value: V;
  label: string;
  /** Absent until the rows have been read; never a zero nobody counted. */
  count: number | null;
  tone?: CountTone;
}

const props = defineProps<{ modelValue: T; options: readonly FilterOption<T>[]; label: string }>();
const emit = defineEmits<{ (event: "update:modelValue", value: T): void }>();

function onKeydown(event: KeyboardEvent): void {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const index = props.options.findIndex((option) => option.value === props.modelValue);
  if (index === -1) return;
  event.preventDefault();
  const last = props.options.length - 1;
  const at = event.key === "Home" ? 0 : event.key === "End" ? last : (index + (event.key === "ArrowRight" ? 1 : -1) + props.options.length) % props.options.length;
  const next = props.options[at]!;
  emit("update:modelValue", next.value);
  const group = event.currentTarget as HTMLElement;
  group.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
}
</script>

<template>
  <div class="pc-lens-tabs ng-filter" role="radiogroup" :aria-label="label" @keydown="onKeydown">
    <button
      v-for="option in options"
      :key="option.value"
      class="pc-lens-tab"
      type="button"
      role="radio"
      :aria-checked="modelValue === option.value ? 'true' : 'false'"
      :tabindex="modelValue === option.value ? 0 : -1"
      :data-value="option.value"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
      <PcCount v-if="option.count !== null" :value="option.count" :tone="option.tone" />
    </button>
  </div>
</template>
