<script setup lang="ts">
/**
 * One node, intent beside evidence, in the node's side panel.
 *
 * The action row comes first because it is what the operator opened the node
 * for: edit the binding, review and apply, or adopt a legacy baseline (which
 * asks first, with a preview of what the next apply installs). Then the
 * node's own unexplained ports with a suggestion each, the lint findings, the
 * three facts cards,
 * the listeners, the interfaces and the generated ruleset. The block refuses
 * to imply agreement it cannot prove: when a node has never reported, the
 * evidence side says so plainly instead of rendering empty tables that read
 * like "nothing is listening".
 */
import { computed } from "vue";
import { Pencil, Play } from "@lucide/vue";

import { PcButton, PcKindChip, PcNotice, PcSkeleton, PcStateDot, PcStatePill } from "@latticenet/plugin-bridge/chassis";

import { bindPlacement, formatProcesses, indexInterfaces, zoneIndex, type BindPlacement, type Finding } from "../exposure";
import {
  driftLabel,
  driftToneFor,
  driftUnknownReason,
  snapshotLabel,
  snapshotToneFor,
  uncompiledNote,
  type PostureRow,
} from "../posture";
import {
  endSentence,
  orderListeners,
  severityTone,
  suggestionsByPort,
  type GuardListener,
  type GuardSuggestion,
  type GuardZone,
  type Review,
} from "../netguardModel";
import { stampUtc } from "../time";
import { stateTone } from "../tones";

const props = defineProps<{
  row: PostureRow;
  review?: Review;
  loading: boolean;
  /** The review request failed; a compile error is read from `review`. */
  reviewError: string;
  /** This node's open ports that no rule explains, ignored ones included. */
  findings: readonly Finding[];
  ignored: ReadonlySet<string>;
  /** The overview's zones, so a bind address can be placed in one. */
  zones: readonly GuardZone[];
  canAdmin: boolean;
  canPlan: boolean;
  /**
   * Whether the overview read returned this node's binding. Without it the
   * coverage below is empty or an earlier read's, so the panel offers no
   * action and states nothing that coverage alone decides.
   */
  rulesRead: boolean;
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
const uncompiled = computed(() => uncompiledNote(props.row.coverage));
const suggestions = computed(() => props.review?.suggestions ?? []);
const portIndex = computed(() => suggestionsByPort(suggestions.value));

/**
 * Where each socket's bind puts it. The server's per-port hints describe what
 * the internet can reach, so they are shown only under a public bind; a
 * socket on loopback or on a zone address carries its placement instead of
 * a warning it cannot earn.
 */
const zoneMap = computed(() => zoneIndex(props.zones, props.review?.node?.zones));
const interfaceFacts = computed(() => indexInterfaces(reality.value?.interfaces));
const placements = computed(
  () => new Map((reality.value?.listeners ?? []).map((listener) => [listener, bindPlacement(listener, zoneMap.value, interfaceFacts.value)] as const)),
);
function placementOf(listener: GuardListener): BindPlacement {
  return placements.value.get(listener) ?? bindPlacement(listener, zoneMap.value, interfaceFacts.value);
}
function hintsFor(listener: GuardListener): GuardSuggestion[] {
  return placementOf(listener).kind === "public" ? (portIndex.value.get(listener.port ?? -1) ?? []) : [];
}
const flaggedPorts = computed(
  () => new Set([...placements.value].filter(([listener, placement]) => placement.kind === "public" && portIndex.value.has(listener.port ?? -1)).map(([listener]) => listener.port ?? -1)),
);
const listeners = computed(() => orderListeners(reality.value?.listeners ?? [], flaggedPorts.value));
/** "10 reported: 6 public, 2 tailscale only, 2 local only." */
const listenerTally = computed(() => {
  const counts = new Map<string, number>();
  for (const placement of placements.value.values()) counts.set(placement.label, (counts.get(placement.label) ?? 0) + 1);
  const order = (label: string): number => (label === "public" ? 0 : label === "bind not reported" ? 3 : label === "local only" ? 2 : 1);
  return [...counts.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
});
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
      <span v-if="!rulesRead" class="ng-detail-note">no actions: the overview read failed, so this node's binding is not known; Refresh reads it again</span>
      <span v-else-if="!canAdmin && !canPlan" class="ng-detail-note">read-only: this session can view this node and change nothing</span>
      <template v-if="rulesRead && hasActions">
        <PcButton v-if="row.coverage === 'legacy' && canAdmin" @click="emit('adopt')">Adopt baseline…</PcButton>
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
      <PcNotice v-if="reviewError" tone="warning" title="This node's review could not be read">
        <p>{{ endSentence(reviewError) }} The reported evidence below is still accurate.</p>
      </PcNotice>
      <!-- A node NetGuard does not manage has no table to compile: that is
           its state, said as such, not a warning. -->
      <p v-else-if="review?.compile_error && uncompiled && rulesRead" class="ng-uncompiled">
        <strong>{{ uncompiled.title }}.</strong> {{ uncompiled.body }}
      </p>
      <PcNotice v-else-if="review?.compile_error" tone="warning" title="Intent could not be compiled for this node">
        <p>{{ endSentence(review.compile_error) }} The reported evidence below is still accurate.</p>
      </PcNotice>

      <section v-if="findings.length" class="ng-attn" aria-label="Open ports nothing explains on this node">
        <div v-for="finding in findings" :key="finding.key" class="ng-attn-row" :data-ignored="ignored.has(finding.key) ? 'true' : undefined">
          <PcStateDot :tone="ignored.has(finding.key) ? 'neutral' : 'error'" :label="ignored.has(finding.key) ? 'ignored' : 'no rule'" />
          <div class="ng-attn-claim">
            <span>{{ finding.sentence }}</span>
            <small class="pc-mono">{{ formatProcesses(finding.span) || 'owner unknown' }} · {{ finding.span.protocol }}</small>
            <small v-if="ignored.has(finding.key)">Ignored until this page reloads. Nothing is saved and the port still counts as open.</small>
            <small v-else class="ng-attn-hint">{{ finding.hint }}</small>
          </div>
          <div class="ng-attn-actions">
            <PcButton v-if="ignored.has(finding.key)" compact @click="emit('restore', finding.key)">Undo</PcButton>
            <template v-else>
              <PcButton v-if="canAdmin" compact @click="emit('add', finding)">Add to group</PcButton>
              <PcButton compact title="Hide this finding until the page reloads. Nothing is saved." @click="emit('ignore', finding.key)">Ignore for this session</PcButton>
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
            <dd v-if="!rulesRead" class="ng-subtle">not read</dd>
            <dd v-else>{{ row.groupIds.length ? row.groupIds.join(', ') : 'none attached' }}</dd>
            <dt>Trusted zones</dt>
            <dd v-if="!rulesRead" class="ng-subtle">not read</dd>
            <dd v-else>{{ row.zoneIds.length ? row.zoneIds.join(', ') : 'none' }}</dd>
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
            {{ listeners.length }} reported: {{ listenerTally }}. An owner of "unknown" means the agent
            could not read the owning process, which needs root on the node.
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
                  <template v-if="placementOf(listener).kind === 'public'">
                    <template v-for="hint in hintsFor(listener)" :key="hint.id">
                      <PcStatePill :tone="stateTone(severityTone(hint.severity))" :label="hint.title" :title="hint.detail" />
                    </template>
                    <span v-if="!hintsFor(listener).length" class="ng-absent">no finding</span>
                  </template>
                  <span v-else-if="placementOf(listener).kind === 'unknown'" class="ng-absent" :title="placementOf(listener).detail">{{ placementOf(listener).label }}</span>
                  <PcKindChip v-else :title="placementOf(listener).detail">{{ placementOf(listener).label }}</PcKindChip>
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
