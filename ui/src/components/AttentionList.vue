<script setup lang="ts">
/**
 * What needs a hand, first on the Overview: each item is the claim with its
 * count, the rows that prove it, and the one action that clears it. Renders
 * nothing when nothing needs a hand; the numbers below say that on their own.
 */
import { computed, ref } from "vue";

import { PcButton } from "@latticenet/plugin-bridge/chassis";

import type { AttentionItem } from "../overview";

const props = withDefaults(defineProps<{ items: readonly AttentionItem[]; max?: number }>(), { max: 5 });
const emit = defineEmits<{ (event: "act", item: AttentionItem): void }>();

const showAll = ref(false);
const shown = computed(() => (showAll.value ? props.items : props.items.slice(0, props.max)));
</script>

<template>
  <section v-if="items.length" class="ng-attention" aria-labelledby="ng-attention-title">
    <h2 id="ng-attention-title" class="pc-sr-only">Needs attention</h2>
    <ul>
      <li v-for="item in shown" :key="item.key" :data-tone="item.tone">
        <div class="ng-attention-copy">
          <strong>{{ item.claim }}</strong>
          <span :title="item.proof">{{ item.proof }}</span>
        </div>
        <PcButton compact @click="emit('act', item)">{{ item.action.label }}</PcButton>
      </li>
    </ul>
    <button v-if="items.length > max && !showAll" type="button" class="ng-attention-more" @click="showAll = true">Show all {{ items.length }}</button>
  </section>
</template>
