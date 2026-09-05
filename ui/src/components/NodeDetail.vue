<script setup lang="ts">
/**
 * One node, intent beside evidence, folded under its row.
 *
 * The action row comes first because it is what the operator opened the row
 * for: edit the binding, review and apply, or adopt a legacy baseline. Then
 * the node's own unexplained ports, the lint findings, the three facts cards,
 * the listeners, the interfaces and the generated ruleset. The block refuses
 * to imply agreement it cannot prove: when a node has never reported, the
 * evidence side says so plainly instead of rendering empty tables that read
 * like "nothing is listening".
 */
import { computed } from "vue";
import { Pencil, Play } from "@lucide/vue";

import { PcButton, PcNotice, PcSkeleton, PcStateDot, PcStatePill } from "@latticenet/plugin-bridge/chassis";

import { formatProcesses, type Finding } from "../exposure";
import {
  driftLabel,
  driftToneFor,
  driftUnknownReason,
  snapshotLabel,
  snapshotToneFor,
  type PostureRow,
} from "../posture";
import { endSentence, orderListeners, severityTone, suggestionsByPort, type Review } from "../netguardModel";
import { stampUtc } from "../time";
import { stateTone } from "../tones";

const props = defineProps<{
  row: PostureRow;
  review?: Review;
  loading: boolean;
  reviewError: string;
  /** This node's open ports that no rule explains, ignored ones included. */
  findings: readonly Finding[];
  ignored: ReadonlySet<string>;
  canAdmin: boolean;
  canPlan: boolean;
}>();

const emit = defineEmits<{
  (event: "edit-binding"): void;
  (event: "plan"): void;
  (event: "adopt"): void;
  (event: "add", finding: Finding): void;
  (event: "ignore", key: string): void;
  (event: "restore", key: string): void;
}>();

const reality = computed(() => props.review?.reality?.reality ?? undefined);
const suggestions = computed(() => props.review?.suggestions ?? []);
const portIndex = computed(() => suggestionsByPort(suggestions.value));
const flaggedPorts = computed(() => new Set(portIndex.value.keys()));
const listeners = computed(() => orderListeners(reality.value?.listeners ?? [], flaggedPorts.value));
const interfaces = computed(() => reality.value?.interfaces ?? []);
const foreignTables = computed(() => reality.value?.foreign_tables ?? []);
const lint = computed(() => props.review?.findings ?? []);
const blocking = computed(() => lint.value.some((finding) => finding.severity === "block"));

const hasActions = computed(
  () =>
    (props.row.coverage === "legacy" && props.canAdmin) ||
    (props.canAdmin && props.row.coverage !== "legacy" && Boolean(props.row.intent)) ||
    (props.canPlan && props.row.coverage === "managed"),
);

/**
 * The two hashes that define drift, shown together. Neither is meaningful
 * alone, and a block that shows only one invites the reader to assume the
 * other matches.
 */
const hashes = computed(() => ({
  applied: props.row.appliedTableSha || "",
  live: props.row.managedSha || "",
}));

function severityLabel(severity: string): string {
  return severity === "block" ? "blocking" : severity;
}

function lintTone(severity: string): "error" | "warning" {
  return severity === "block" ? "error" : "warning";
}
</script>

<template>
  <div class="ng-detail">
    <div class="ng-detail-actions">
      <span v-if="!canAdmin && !canPlan" class="ng-detail-note">read-only: this session can view this node and change nothing</span>
      <template v-if="hasActions">
        <PcButton v-if="row.coverage === 'legacy' && canAdmin" @click="emit('adopt')">Adopt baseline</PcButton>
        <PcButton v-if="canAdmin && row.coverage !== 'legacy' && row.intent" @click="emit('edit-binding')">
          <template #icon><Pencil :size="14" /></template>Edit binding
        </PcButton>
        <PcButton v-if="canPlan && row.coverage === 'managed'" variant="primary" @click="emit('plan')">
          <template #icon><Play :size="14" /></template>Review and apply
        </PcButton>
      </template>
    </div>

    <PcSkeleton v-if="loading" :count="3" :label="`Loading ${row.nodeName}`" />

    <template v-else>
      <PcNotice v-if="reviewError" tone="warning" title="Intent could not be compiled for this node">
        <p>{{ endSentence(reviewError) }} The reported evidence below is still accurate.</p>
      </PcNotice>

      <section v-if="findings.length" class="ng-attn" aria-label="Open ports nothing explains on this node">
        <div v-for="finding in findings" :key="finding.key" class="ng-attn-row" :data-ignored="ignored.has(finding.key) ? 'true' : undefined">
          <PcStateDot :tone="ignored.has(finding.key) ? 'neutral' : 'error'" :label="ignored.has(finding.key) ? 'ignored' : 'open'" />
          <div class="ng-attn-claim">
            <span>{{ finding.sentence }}</span>
            <small class="pc-mono">{{ formatProcesses(finding.span) || 'owner unknown' }} · {{ finding.span.protocol }}</small>
          </div>
          <div class="ng-attn-actions">
            <PcButton v-if="ignored.has(finding.key)" compact @click="emit('restore', finding.key)">Undo</PcButton>
            <template v-else>
              <PcButton v-if="canAdmin" compact @click="emit('add', finding)">Add to group</PcButton>
              <PcButton compact @click="emit('ignore', finding.key)">Ignore</PcButton>
            </template>
          </div>
        </div>
      </section>

      <div v-if="lint.length" class="ng-lint">
        <div v-for="finding in lint" :key="finding.code" class="ng-lint-row" :data-severity="finding.severity">
          <PcStateDot :tone="lintTone(finding.severity)" :label="severityLabel(finding.severity)" />
          <div><strong class="pc-mono">{{ finding.code }}</strong> {{ finding.message }}</div>
        </div>
      </div>

      <div class="ng-cards">
        <article class="ng-card">
          <h3>Drift</h3>
          <PcStatePill :tone="stateTone(driftToneFor(row.driftState))" :label="driftLabel(row.driftState)" />
          <p v-if="row.driftState === 'unknown'" class="ng-subtle">{{ driftUnknownReason(row) }}</p>
          <p v-else-if="row.driftState === 'drift'" class="pc-danger-text">
            The managed table on this node no longer matches the ruleset Lattice applied. Someone or
            something changed it outside the control plane.
          </p>
          <p v-else class="ng-subtle">The live managed table matches the ruleset Lattice applied.</p>
          <dl class="ng-kv">
            <dt>Applied by Lattice</dt>
            <dd class="pc-mono">{{ hashes.applied || 'never applied' }}</dd>
            <dt>Live on the node</dt>
            <dd class="pc-mono">{{ hashes.live || 'not reported' }}</dd>
          </dl>
        </article>

        <article class="ng-card">
          <h3>Reporting</h3>
          <PcStatePill :tone="stateTone(snapshotToneFor(row.snapshotStatus))" :label="snapshotLabel(row.snapshotStatus)" />
          <p v-if="row.snapshotStatus === 'unknown'" class="ng-subtle">
            This node has never sent a firewall snapshot. That is expected until its agent is new
            enough to collect one; it is not an error and not an empty firewall.
          </p>
          <dl class="ng-kv">
            <dt>Collected</dt>
            <dd class="pc-mono">{{ row.collectedAt ? stampUtc(row.collectedAt) : 'never' }}</dd>
            <dt>nft version</dt>
            <dd class="pc-mono">{{ reality?.nft_version || 'not reported' }}</dd>
            <dt>Interfaces</dt>
            <dd>{{ reality ? interfaces.length : 'not reported' }}</dd>
          </dl>
        </article>

        <article class="ng-card">
          <h3>Authority</h3>
          <dl class="ng-kv">
            <dt>Security groups</dt>
            <dd>{{ row.groupIds.length ? row.groupIds.join(', ') : 'none attached' }}</dd>
            <dt>Trusted zones</dt>
            <dd>{{ row.zoneIds.length ? row.zoneIds.join(', ') : 'none' }}</dd>
            <dt>Last apply</dt>
            <dd v-if="row.lastError" class="pc-danger-text">{{ row.lastError }}</dd>
            <dd v-else-if="row.lastAppliedAt" class="pc-mono">{{ stampUtc(row.lastAppliedAt) }}</dd>
            <dd v-else class="ng-subtle">Lattice has never applied a ruleset to this node.</dd>
          </dl>
        </article>
      </div>

      <PcNotice v-if="foreignTables.length" tone="warning" :title="`${foreignTables.length} nftables table${foreignTables.length === 1 ? '' : 's'} NetGuard does not manage`">
        <p>
          These rules are in force on the node whatever the control plane thinks. NetGuard neither
          wrote nor will remove them. <code>{{ foreignTables.join(', ') }}</code>
        </p>
      </PcNotice>

      <section class="ng-subpanel">
        <header class="ng-subpanel-head">
          <h3>Listening sockets</h3>
          <p v-if="!reality">Not reported. Nothing here is known to be open or closed.</p>
          <p v-else-if="!listeners.length">
            The node reported no listening sockets. That is a real finding, not a missing snapshot.
          </p>
          <p v-else>
            {{ listeners.length }} reported. An owner of "unknown" means the agent could not read the
            owning process, which needs root on the node.
          </p>
        </header>
        <div v-if="listeners.length" class="ng-facts-wrap">
          <table class="ng-facts">
            <thead>
              <tr><th>Port</th><th>Protocol</th><th>Bound address</th><th>Owning process</th><th>Assessment</th></tr>
            </thead>
            <tbody>
              <tr v-for="listener in listeners" :key="`${listener.protocol}-${listener.address}-${listener.port}`">
                <td class="pc-mono"><strong>{{ listener.port }}</strong></td>
                <td class="pc-mono">{{ listener.protocol || 'unknown' }}</td>
                <td class="pc-mono">{{ listener.address || 'all addresses' }}</td>
                <td class="pc-mono">{{ listener.process || 'unknown' }}</td>
                <td>
                  <template v-for="hint in portIndex.get(listener.port ?? -1) ?? []" :key="hint.id">
                    <PcStatePill :tone="stateTone(severityTone(hint.severity))" :label="hint.title" :title="hint.detail" />
                  </template>
                  <span v-if="!(portIndex.get(listener.port ?? -1) ?? []).length" class="ng-absent">no finding</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="reality && interfaces.length" class="ng-subpanel">
        <header class="ng-subpanel-head"><h3>Interfaces</h3></header>
        <div class="ng-facts-wrap">
          <table class="ng-facts">
            <thead><tr><th>Name</th><th>State</th><th>Addresses</th></tr></thead>
            <tbody>
              <tr v-for="iface in interfaces" :key="iface.name">
                <td class="pc-mono"><strong>{{ iface.name }}</strong></td>
                <td><PcStateDot :tone="iface.up ? 'healthy' : 'neutral'" :label="iface.up ? 'up' : 'down'" /></td>
                <td class="pc-mono">{{ (iface.addresses ?? []).join(', ') || 'none' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="ng-subpanel">
        <header class="ng-subpanel-head">
          <h3>Generated ruleset</h3>
          <p>
            The nft text this node's zones, groups and overrides compile to. This is the escape hatch
            behind the rule model: what Lattice would install, exactly.
          </p>
        </header>
        <pre v-if="review?.ruleset" class="ng-code">{{ review.ruleset }}</pre>
        <p v-else class="ng-subpanel-body ng-subtle">
          {{ review?.compile_error || 'This node has no compiled intent yet.' }}
        </p>
      </section>

      <PcNotice v-if="blocking" tone="danger" title="This node will not plan without an audited acceptance">
        <p>The lockout finding above has to be accepted explicitly in the apply dialog, and the acceptance is recorded against your account.</p>
      </PcNotice>
    </template>
  </div>
</template>
