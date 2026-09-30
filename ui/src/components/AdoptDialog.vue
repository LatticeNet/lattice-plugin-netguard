<script setup lang="ts">
/**
 * The question in front of "Adopt baseline". Adopting writes nothing to the
 * node, but it hands the node to NetGuard, and the next approved apply
 * replaces whatever firewall the node runs now with a default-drop table
 * built from the baseline's rules. So the dialog shows what that table
 * accepts, which zones it trusts, and which ports open right now it would
 * close, including ports reachable today only through the knock gate or a
 * zone bind that the new table would not keep, before the operator agrees.
 * Nothing here is guessed: open ports are
 * named only from a fresh snapshot, and the nft text itself is left to Review
 * and apply, which is the only place the server compiles it.
 */
import { computed } from "vue";

import { PcButton, PcModal, PcNotice } from "@latticenet/plugin-bridge/chassis";

import type { AdoptPreview } from "../adopt";

const props = defineProps<{
  open: boolean;
  nodeName: string;
  preview?: AdoptPreview;
  busy: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm"): void;
}>();

const evidenceNote = computed(() => {
  switch (props.preview?.evidence) {
    case "stale":
      return "This node's last snapshot is stale, so which of its open ports that apply would close is not known.";
    case "none":
      return "This node has never sent a snapshot, so which of its open ports that apply would close is not known.";
    case "reading":
      return "This node's snapshot is still being read. Close this and open it again in a moment to see which open ports that apply would close.";
    default:
      return "";
  }
});

function close(): void {
  if (!props.busy) emit("close");
}
</script>

<template>
  <PcModal
    :open="open"
    :title="`Adopt the baseline on ${nodeName}?`"
    description="Adopting changes nothing on the node. The next approved apply does."
    @close="close"
  >
    <div v-if="preview" class="ng-stack ng-adopt">
      <p>
        NetGuard saves the imported rules as the group <strong>{{ preview.groupNames.join(', ') || 'baseline' }}</strong>,
        binds it to {{ nodeName }} and turns management on. The node keeps the firewall it runs now until an apply is approved.
      </p>

      <section class="ng-subpanel" aria-labelledby="ng-adopt-installs">
        <header class="ng-subpanel-head">
          <h3 id="ng-adopt-installs">What the next apply installs</h3>
          <p>Anything the rules below do not accept is dropped. Loopback and replies to connections the node opened stay accepted.</p>
        </header>
        <div class="ng-subpanel-body">
          <p class="ng-adopt-zones">
            <span>Trusted zones</span>
            <strong>{{ preview.zones.length ? preview.zones.join(', ') : 'none' }}</strong>
          </p>
          <ol v-if="preview.rules.length" class="ng-adopt-rules">
            <li v-for="rule in preview.rules" :key="rule.key" :data-disabled="rule.disabled ? 'true' : undefined">
              <span class="pc-mono">{{ rule.sentence }}</span>
              <small v-if="rule.disabled">off, not compiled</small>
              <small v-else-if="rule.comment">{{ rule.comment }}</small>
            </li>
          </ol>
          <p v-else class="pc-danger-text">The baseline has no rules, so that apply accepts nothing but loopback and replies.</p>
        </div>
      </section>

      <PcNotice v-if="evidenceNote" tone="warning"><p>{{ evidenceNote }}</p></PcNotice>
      <template v-else>
        <PcNotice v-if="preview.dropped.length" title="Open now, and closed by that apply">
          <p class="pc-mono">{{ preview.dropped.join(', ') }}</p>
        </PcNotice>
        <!-- Not "open with no rule": these reach the node through the knock
             gate or a zone bind today, and the new table does not keep that
             path. Never folded into the all-clear below. -->
        <PcNotice v-if="preview.cut.length" title="Reachable today by another path, and not accepted by the new table">
          <ul class="ng-adopt-cut">
            <li v-for="item in preview.cut" :key="item.port">
              <strong class="pc-mono">{{ item.port }}</strong>
              <span>{{ item.reason }}</span>
            </li>
          </ul>
        </PcNotice>
        <p v-if="(preview.dropped.length || preview.cut.length) && preview.uncertain.length">
          Also open with a bind the snapshot does not report, so they may close too: <span class="pc-mono">{{ preview.uncertain.join(', ') }}</span>
        </p>
        <p v-if="!preview.dropped.length && !preview.cut.length" class="ng-subtle">
          Every port this node listens on beyond loopback stays reachable the way it is today: a rule above or a trusted zone accepts it{{ preview.uncertain.length ? `, except ${preview.uncertain.join(', ')}, whose bind the snapshot does not report` : '' }}.
        </p>
      </template>

      <p class="ng-subtle">
        This preview reads listening sockets only. Traffic no listening socket shows, such as ESP for IPsec or a DHCP server on a raw socket, is not listed here and can be dropped by that apply too.
        The exact nft text is compiled once the node is adopted. Review and apply shows it, with the lint findings, before any approval exists.
      </p>

      <PcNotice v-if="error"><p>{{ error }}</p></PcNotice>
    </div>

    <template #footer>
      <PcButton :disabled="busy" @click="close">Cancel</PcButton>
      <PcButton variant="primary" :busy="busy" @click="emit('confirm')">Adopt {{ nodeName }}</PcButton>
    </template>
  </PcModal>
</template>
