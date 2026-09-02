<script setup lang="ts">
/**
 * One node, intent beside evidence.
 *
 * The left half is what an operator declared; the right half is what the
 * machine reports. The panel refuses to imply agreement it cannot prove: when a
 * node has never reported, the evidence side says so plainly instead of
 * rendering empty tables that read like "nothing is listening".
 */
import { computed } from "vue";
import { CircleAlert, LoaderCircle, Play, Pencil, ShieldCheck, TriangleAlert } from "@lucide/vue";

import StatusPill from "./StatusPill.vue";
import {
  driftLabel,
  driftToneFor,
  driftUnknownReason,
  snapshotLabel,
  snapshotToneFor,
  type PostureRow,
} from "../posture";
import {
  endSentence,
  orderListeners,
  severityTone,
  suggestionsByPort,
  type Review,
} from "../netguardModel";

const props = defineProps<{
  row: PostureRow;
  review?: Review;
  loading: boolean;
  reviewError: string;
  canAdmin: boolean;
  canPlan: boolean;
}>();

const emit = defineEmits<{
  (event: "edit-binding"): void;
  (event: "plan"): void;
  (event: "adopt"): void;
}>();

const reality = computed(() => props.review?.reality?.reality ?? undefined);
const suggestions = computed(() => props.review?.suggestions ?? []);
const portIndex = computed(() => suggestionsByPort(suggestions.value));
const flaggedPorts = computed(() => new Set(portIndex.value.keys()));
const listeners = computed(() => orderListeners(reality.value?.listeners ?? [], flaggedPorts.value));
const interfaces = computed(() => reality.value?.interfaces ?? []);
const foreignTables = computed(() => reality.value?.foreign_tables ?? []);
const findings = computed(() => props.review?.findings ?? []);
const blocking = computed(() => findings.value.some((finding) => finding.severity === "block"));

/**
 * The two hashes that define drift, shown together. Neither is meaningful
 * alone, and a panel that shows only one invites the reader to assume the
 * other matches.
 */
const hashes = computed(() => ({
  applied: props.row.appliedTableSha || "",
  live: props.row.managedSha || "",
}));

function severityLabel(severity: string): string {
  return severity === "block" ? "blocking" : severity;
}
</script>

<template>
  <section class="panel detail">
    <header class="detail-head">
      <div>
        <h2>{{ row.nodeName }}</h2>
        <p class="mono subtle">{{ row.nodeId }}</p>
      </div>
      <div class="detail-actions">
        <button
          v-if="row.coverage === 'legacy' && canAdmin"
          class="button secondary"
          type="button"
          @click="emit('adopt')"
        >
          Adopt baseline
        </button>
        <button
          v-if="canAdmin && row.coverage !== 'legacy' && row.intent"
          class="button secondary"
          type="button"
          @click="emit('edit-binding')"
        >
          <Pencil :size="14" />Edit binding
        </button>
        <button
          v-if="canPlan && row.coverage === 'managed'"
          class="button primary"
          type="button"
          @click="emit('plan')"
        >
          <Play :size="14" />Review and apply
        </button>
      </div>
    </header>

    <div v-if="loading" class="loading">
      <LoaderCircle class="spin" :size="18" />Loading this node
    </div>

    <template v-else>
      <div v-if="reviewError" class="notice warn">
        <TriangleAlert :size="16" />
        <div>
          <strong>Intent could not be compiled for this node</strong>
          <p>{{ endSentence(reviewError) }}</p>
          <p>The reported evidence below is still accurate.</p>
        </div>
      </div>

      <div v-if="findings.length" class="findings">
        <div v-for="finding in findings" :key="finding.code" class="finding" :data-severity="finding.severity">
          <CircleAlert :size="15" />
          <div>
            <strong>{{ severityLabel(finding.severity) }}: {{ finding.code }}</strong>
            <p>{{ finding.message }}</p>
          </div>
        </div>
      </div>

      <div class="detail-grid">
        <article class="detail-card">
          <h3>Drift</h3>
          <StatusPill :tone="driftToneFor(row.driftState)" :label="driftLabel(row.driftState)" />
          <p v-if="row.driftState === 'unknown'" class="subtle">{{ driftUnknownReason(row) }}</p>
          <p v-else-if="row.driftState === 'drift'" class="danger-text">
            The managed table on this node no longer matches the ruleset Lattice applied. Someone or
            something changed it outside the control plane.
          </p>
          <p v-else class="subtle">The live managed table matches the ruleset Lattice applied.</p>
          <dl class="kv">
            <dt>Applied by Lattice</dt>
            <dd class="mono">{{ hashes.applied || 'never applied' }}</dd>
            <dt>Live on the node</dt>
            <dd class="mono">{{ hashes.live || 'not reported' }}</dd>
          </dl>
        </article>

        <article class="detail-card">
          <h3>Reporting</h3>
          <StatusPill
            :tone="snapshotToneFor(row.snapshotStatus)"
            :label="snapshotLabel(row.snapshotStatus)"
          />
          <p v-if="row.snapshotStatus === 'unknown'" class="subtle">
            This node has never sent a firewall snapshot. That is expected until its agent is new
            enough to collect one; it is not an error and not an empty firewall.
          </p>
          <dl class="kv">
            <dt>Collected</dt>
            <dd>{{ row.collectedAt ? new Date(row.collectedAt).toLocaleString() : 'never' }}</dd>
            <dt>nft version</dt>
            <dd class="mono">{{ reality?.nft_version || 'not reported' }}</dd>
            <dt>Interfaces</dt>
            <dd>{{ reality ? interfaces.length : 'not reported' }}</dd>
          </dl>
        </article>

        <article class="detail-card">
          <h3>Authority</h3>
          <p class="subtle">
            Security groups: {{ row.groupIds.length ? row.groupIds.join(', ') : 'none attached' }}
          </p>
          <p class="subtle">
            Trusted zones: {{ row.zoneIds.length ? row.zoneIds.join(', ') : 'none' }}
          </p>
          <p v-if="row.lastError" class="danger-text">Last apply: {{ row.lastError }}</p>
          <p v-else-if="row.lastAppliedAt" class="subtle">
            Last applied {{ new Date(row.lastAppliedAt).toLocaleString() }}
          </p>
          <p v-else class="subtle">Lattice has never applied a ruleset to this node.</p>
        </article>
      </div>

      <div v-if="foreignTables.length" class="notice warn">
        <TriangleAlert :size="16" />
        <div>
          <strong>{{ foreignTables.length }} nftables table{{ foreignTables.length === 1 ? '' : 's' }} NetGuard does not manage</strong>
          <p>
            These rules are in force on the node whatever the control plane thinks. NetGuard neither
            wrote nor will remove them.
          </p>
          <p class="mono">{{ foreignTables.join(', ') }}</p>
        </div>
      </div>

      <section class="subpanel">
        <header class="subpanel-head">
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
        <div v-if="listeners.length" class="table-scroll">
          <table>
            <thead>
              <tr><th>Port</th><th>Protocol</th><th>Bound address</th><th>Owning process</th><th>Assessment</th></tr>
            </thead>
            <tbody>
              <tr v-for="listener in listeners" :key="`${listener.protocol}-${listener.address}-${listener.port}`">
                <td class="mono"><strong>{{ listener.port }}</strong></td>
                <td class="mono">{{ listener.protocol || 'unknown' }}</td>
                <td class="mono">{{ listener.address || 'all addresses' }}</td>
                <td class="mono">{{ listener.process || 'unknown' }}</td>
                <td>
                  <template v-for="hint in portIndex.get(listener.port ?? -1) ?? []" :key="hint.id">
                    <StatusPill :tone="severityTone(hint.severity)" :label="hint.title" :title="hint.detail" />
                  </template>
                  <span v-if="!(portIndex.get(listener.port ?? -1) ?? []).length" class="absent">no finding</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="reality && interfaces.length" class="subpanel">
        <header class="subpanel-head"><h3>Interfaces</h3></header>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>State</th><th>Addresses</th></tr></thead>
            <tbody>
              <tr v-for="iface in interfaces" :key="iface.name">
                <td class="mono"><strong>{{ iface.name }}</strong></td>
                <td><StatusPill :tone="iface.up ? 'ok' : 'muted'" :label="iface.up ? 'up' : 'down'" /></td>
                <td class="mono">{{ (iface.addresses ?? []).join(', ') || 'none' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="subpanel">
        <header class="subpanel-head">
          <h3>Generated ruleset</h3>
          <p>
            The nft text this node's zones, groups and overrides compile to. This is the escape hatch
            behind the rule model: what Lattice would install, exactly.
          </p>
        </header>
        <pre v-if="review?.ruleset" class="code">{{ review.ruleset }}</pre>
        <p v-else class="subpanel-body subtle">
          {{ review?.compile_error || 'This node has no compiled intent yet.' }}
        </p>
      </section>

      <p v-if="blocking" class="notice danger">
        <ShieldCheck :size="16" />
        <span>
          This node's current intent will not plan without an explicit, audited acceptance of the
          lockout risk above.
        </span>
      </p>
    </template>
  </section>
</template>
