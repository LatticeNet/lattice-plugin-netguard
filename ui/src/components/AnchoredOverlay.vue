<script setup lang="ts">
/**
 * A modal that works inside a plugin frame.
 *
 * The host sizes this iframe to its reported content height, so the frame is
 * not a viewport: `position: fixed` resolves against the whole document (which
 * may be several thousand pixels tall) and `position: sticky` never activates
 * because nothing scrolls inside the frame. A fixed, centred modal therefore
 * lands in the middle of the document rather than in front of the operator.
 *
 * So the overlay is absolutely positioned against a measured anchor: the
 * element the operator clicked. The backdrop spans the whole document, and the
 * panel opens next to the action that summoned it, which is where the eye
 * already is.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "@lucide/vue";

import { clampAnchorTop } from "../anchor";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    subtitle?: string;
    /** Document-space y offset to open against, from measureAnchor(). */
    anchorTop?: number;
    width?: "regular" | "wide" | "narrow";
    busy?: boolean;
  }>(),
  { width: "regular", busy: false, anchorTop: 0, subtitle: "" },
);

const emit = defineEmits<{ (event: "close"): void }>();

const panel = ref<HTMLElement>();

/**
 * Keep the panel inside the document. An anchor near the bottom of a long fleet
 * would otherwise push a tall dialog past the frame's height, and the host would
 * either clip it or grow the frame around empty space. The clamp needs the
 * panel's real height, so it runs once the panel exists rather than being
 * derived from the anchor alone.
 */
const top = ref(0);

async function place(): Promise<void> {
  top.value = clampAnchorTop(props.anchorTop ?? 0);
  await nextTick();
  const height = panel.value?.getBoundingClientRect().height ?? 0;
  top.value = clampAnchorTop(props.anchorTop ?? 0, height);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.open && !props.busy) emit("close");
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    await place();
    panel.value?.focus();
  },
);

// A dialog whose body grows after opening (a diff loading in, an error notice
// appearing) has to be re-placed, or it can end up hanging off the document.
watch(() => props.anchorTop, () => void place());
</script>

<template>
  <div v-if="open" class="overlay-root">
    <div class="overlay-scrim" @click="busy ? undefined : emit('close')" />
    <section
      ref="panel"
      class="overlay-panel"
      :class="width"
      :style="{ top: `${top}px` }"
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
