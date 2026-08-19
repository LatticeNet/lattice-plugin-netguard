<script setup lang="ts">
/**
 * One semantic state, stated in words and reinforced by colour.
 *
 * Colour is never the only carrier: every pill reads correctly in greyscale,
 * because "drifted" and "in sync" being one hue apart is not a distinction an
 * operator should have to trust their monitor for.
 */
withDefaults(
  defineProps<{ tone: "ok" | "warn" | "danger" | "muted"; label: string; title?: string }>(),
  { title: "" },
);
</script>

<template>
  <span class="pill" :data-tone="tone" :title="title || undefined">
    <span class="pill-dot" aria-hidden="true" />{{ label }}
  </span>
</template>
