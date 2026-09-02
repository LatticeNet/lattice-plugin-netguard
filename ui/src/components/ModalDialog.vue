<script setup lang="ts">
/**
 * A modal inside a plugin frame that is a viewport.
 *
 * The host sizes this iframe to fill the console's main region, so the frame
 * is the window the operator sees: `position: fixed` covers exactly it and a
 * centred panel opens in front of the eye. This used to measure the element
 * the operator clicked and open beside it in document coordinates, from the
 * days when the host sized the frame to the content height it was told and
 * fixed positioning landed anywhere; that anchor is gone with the frame model
 * it served.
 *
 * The scrim closes on click, Escape closes from anywhere, and neither works
 * while `busy`, because a half-sent write must not lose its error message.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "@lucide/vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    subtitle?: string;
    width?: "regular" | "wide" | "narrow";
    busy?: boolean;
  }>(),
  { width: "regular", busy: false, subtitle: "" },
);

const emit = defineEmits<{ (event: "close"): void }>();

const panel = ref<HTMLElement>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.open && !props.busy) emit("close");
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    await nextTick();
    // Escape only reaches a focused element, and a dialog that cannot be
    // dismissed from the keyboard is the worst one to get wrong.
    panel.value?.focus();
  },
);
</script>

<template>
  <div v-if="open" class="overlay-root">
    <div class="overlay-scrim" @click="busy ? undefined : emit('close')" />
    <section
      ref="panel"
      class="overlay-panel"
      :class="width"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header class="overlay-head">
        <div class="overlay-title">
          <h2>{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <X :size="15" />
        </button>
      </header>
      <div class="overlay-body"><slot /></div>
      <footer v-if="$slots.footer" class="overlay-foot"><slot name="footer" /></footer>
    </section>
  </div>
</template>
