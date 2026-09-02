<script setup lang="ts">
/**
 * Security-group authoring: ordered rules over ports, protocols and remotes.
 *
 * Order is meaning in nftables, so the editor numbers rules and never reorders
 * them behind the operator's back.
 */
import { reactive, ref, watch } from "vue";
import { Plus, Trash2 } from "@lucide/vue";

import ModalDialog from "./ModalDialog.vue";
import {
  buildRemote,
  formatRanges,
  parseRanges,
  remoteValue,
  type GuardRule,
  type SecurityGroup,
} from "../netguardModel";

const props = defineProps<{
  open: boolean;
  group?: SecurityGroup;
  saving: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", payload: Record<string, unknown>): void;
}>();

type EditableRule = GuardRule & { portsText: string; remoteText: string };

const form = reactive<{ id: string; name: string; description: string; version: number; rules: EditableRule[] }>({
  id: "",
  name: "",
  description: "",
  version: 0,
  rules: [],
});
const localError = ref("");

let ruleSeq = 0;
function blankRule(): EditableRule {
  ruleSeq += 1;
  return {
    id: `rule-${ruleSeq}-${Math.random().toString(16).slice(2, 7)}`,
    action: "allow",
    direction: "ingress",
    protocol: "tcp",
    ports: [],
    portsText: "",
    remote: { kind: "any" },
    remoteText: "",
    comment: "",
    disabled: false,
  };
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    localError.value = "";
    form.id = props.group?.id ?? "";
    form.name = props.group?.name ?? "";
    form.description = props.group?.description ?? "";
    form.version = props.group?.version ?? 0;
    form.rules = (props.group?.rules?.length ? props.group.rules : [blankRule()]).map((rule) => ({
      ...rule,
      ports: rule.ports ?? [],
      portsText: formatRanges(rule.ports),
      remote: rule.remote ?? { kind: "any" },
      remoteText: remoteValue(rule.remote ?? { kind: "any" }),
    }));
  },
  { immediate: true },
);

function submit(): void {
  localError.value = "";
  if (!form.name.trim()) {
    localError.value = "A group needs a name.";
    return;
  }
  let rules: GuardRule[];
  try {
    rules = form.rules.map((rule) => ({
      id: rule.id.trim() || blankRule().id,
      comment: rule.comment?.trim(),
      action: rule.action,
      direction: rule.direction,
      protocol: rule.protocol,
      ports: parseRanges(rule.portsText),
      remote: buildRemote(rule.remote.kind, rule.remoteText),
      disabled: rule.disabled,
    }));
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : "A port range is not valid.";
    return;
  }
  emit("save", {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    version: form.version,
    rules,
  });
}
</script>

<template>
  <ModalDialog
    :open="open"
    :busy="saving"
    width="wide"
    :title="group ? `Edit ${group.name}` : 'New security group'"
    subtitle="Rules are evaluated in order. The chain policy stays default drop, so anything not accepted here is dropped."
    @close="emit('close')"
  >
    <div class="form-grid">
      <label class="field">
        <span>Name</span>
        <input v-model="form.name" type="text" placeholder="web tier" />
      </label>
      <label class="field">
        <span>Identifier</span>
        <input v-model="form.id" type="text" :disabled="Boolean(group)" placeholder="generated when empty" />
      </label>
      <label class="field span-2">
        <span>Description</span>
        <input v-model="form.description" type="text" placeholder="What this group is for" />
      </label>
    </div>

    <section class="subpanel">
      <header class="subpanel-head">
        <h3>Rules</h3>
        <button class="button secondary compact" type="button" @click="form.rules.push(blankRule())">
          <Plus :size="14" />Add rule
        </button>
      </header>
      <div class="rule-editor">
        <div v-for="(rule, index) in form.rules" :key="rule.id" class="rule-edit">
          <span class="rule-index">{{ index + 1 }}</span>
          <label class="field">
            <span>Action</span>
            <select v-model="rule.action"><option value="allow">allow</option><option value="deny">deny</option></select>
          </label>
          <label class="field">
            <span>Direction</span>
            <select v-model="rule.direction"><option value="ingress">ingress</option><option value="egress">egress</option></select>
          </label>
          <label class="field">
            <span>Protocol</span>
            <select v-model="rule.protocol">
              <option value="tcp">tcp</option><option value="udp">udp</option>
              <option value="icmp">icmp</option><option value="icmpv6">icmpv6</option><option value="any">any</option>
            </select>
          </label>
          <label class="field">
            <span>Ports</span>
            <input v-model="rule.portsText" type="text" placeholder="22, 8000-8100" />
          </label>
          <label class="field">
            <span>Remote kind</span>
            <select v-model="rule.remote.kind">
              <option value="any">any</option><option value="cidr">cidr</option><option value="node">node</option>
              <option value="group">group</option><option value="zone">zone</option><option value="domain">domain</option>
            </select>
          </label>
          <label class="field">
            <span>Remote value</span>
            <input v-model="rule.remoteText" type="text" :disabled="rule.remote.kind === 'any'" placeholder="10.0.0.0/8" />
          </label>
          <label class="field">
            <span>Comment</span>
            <input v-model="rule.comment" type="text" placeholder="Why this rule exists" />
          </label>
          <label class="field check">
            <input v-model="rule.disabled" type="checkbox" /><span>Disabled</span>
          </label>
          <button
            class="icon-button destructive"
            type="button"
            aria-label="Remove rule"
            :disabled="form.rules.length === 1"
            @click="form.rules.splice(index, 1)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
    </section>

    <p v-if="localError || error" class="notice danger"><span>{{ localError || error }}</span></p>

    <template #footer>
      <button class="button secondary" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="button primary" type="button" :disabled="saving" @click="submit">Save group</button>
    </template>
  </ModalDialog>
</template>
