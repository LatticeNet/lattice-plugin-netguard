<script setup lang="ts">
/**
 * NetGuard: a firewall control plane for a fleet of small nodes.
 *
 * The surface is organised around one question, asked in this order: is
 * anything wrong right now (fleet posture), what is actually on that machine
 * (node detail), what should be allowed (groups and zones), and what exactly
 * will change if I apply (diff and two-step confirm).
 *
 * Two constraints shape everything below. The frame the host renders this in
 * is sized to reported content height, so it is not a viewport: no fixed
 * positioning, no sticky, and overlays are anchored in document space. And
 * every state has to be honest, because a firewall panel that renders an
 * unreported node as a healthy one is worse than no panel at all.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "@latticenet/plugin-bridge";

import AnchoredOverlay from "./components/AnchoredOverlay.vue";
import ApplyDialog from "./components/ApplyDialog.vue";
import BindingEditor from "./components/BindingEditor.vue";
import FleetTable from "./components/FleetTable.vue";
import GroupEditor from "./components/GroupEditor.vue";
import NodeDetail from "./components/NodeDetail.vue";
import PostureBar from "./components/PostureBar.vue";
import ZoneEditor from "./components/ZoneEditor.vue";
import { anchorTopFrom } from "./anchor";
import {
  countPosture,
  joinPosture,
  matchesFilter,
  searchPosture,
  sortPosture,
  type PostureFilter,
  type PostureRow,
  type SortDirection,
  type SortKey,
} from "./posture";
import {
  formatRanges,
  remoteValue,
  safeErrorMessage,
  toWire,
  type GuardRule,
  type GuardZone,
  type Overview,
  type RealityListResponse,
  type RealitySummary,
  type Review,
  type ReviewResponse,
  type SecurityGroup,
} from "./netguardModel";

const SERVICE = "latticenet.netguard/firewall";
/**
 * The fleet list is paginated. Following the cursor is not optional: stopping
 * at the first page would silently drop nodes from a firewall inventory, and
 * the resulting posture bar would be confidently wrong. The bound exists so a
 * broken cursor cannot spin forever.
 */
const REALITY_PAGE_LIMIT = 200;
const REALITY_MAX_PAGES = 50;

const init = ref<HostInit>();
const overview = ref<Overview>({ nodes: [], groups: [], zones: [] });
const realityRows = ref<RealitySummary[]>([]);
const realityTruncated = ref(false);
const tab = ref<"fleet" | "groups" | "zones">("fleet");
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const bootError = ref("");

let bridge: BridgeClient | undefined;
try {
  bridge = new BridgeClient({
    window,
    expectedPluginId: "latticenet.netguard",
    expectedRoutes: ["firewall"],
    idPrefix: "netguard",
  });
  bridge.init
    .then(async (value) => {
      init.value = value;
      await refresh();
    })
    .catch((cause) => {
      bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
      loading.value = false;
    });
} catch (cause) {
  bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
  loading.value = false;
}

const canAdmin = computed(() =>
  ["upsert_group", "delete_group", "upsert_zone", "delete_zone", "upsert_binding", "adopt"].every(
    (method) => canCall(init.value, SERVICE, method),
  ),
);
const canPlan = computed(() => canCall(init.value, SERVICE, "plan"));
const canSeeReality = computed(
  () => canCall(init.value, SERVICE, "reality") && canCall(init.value, SERVICE, "review"),
);

async function call<T>(method: string, payload: unknown = {}): Promise<T> {
  if (!bridge || !canCall(init.value, SERVICE, method)) {
    throw new Error(`Method ${method} is not available for this session`);
  }
  // toWire, not the payload as given: these payloads are assembled from
  // reactive forms, and postMessage cannot structured-clone a Vue proxy.
  return bridge.call<T>(SERVICE, method, toWire(payload)).promise;
}

// ── fleet posture ───────────────────────────────────────────────────────────

const filter = ref<PostureFilter>("all");
const search = ref("");
const sortKey = ref<SortKey>("attention");
const sortDirection = ref<SortDirection>("asc");

const posture = computed(() => joinPosture(overview.value.nodes, realityRows.value));
const counts = computed(() => countPosture(posture.value));
const visibleRows = computed(() =>
  sortPosture(
    searchPosture(posture.value, search.value).filter((row) => matchesFilter(row, filter.value)),
    sortKey.value,
    sortDirection.value,
  ),
);

function onSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = "asc";
}

// ── selected node ───────────────────────────────────────────────────────────

const selectedNodeId = ref("");
const review = ref<Review>();
const reviewLoading = ref(false);
const reviewError = ref("");
/**
 * The ruleset as it stood when this node was opened. It is the left side of the
 * apply diff: the only "before" a client can honestly show, because a reality
 * snapshot reports the live table as a hash and never as text.
 */
const rulesetBaseline = ref("");

const selectedRow = computed<PostureRow | undefined>(() =>
  posture.value.find((row) => row.nodeId === selectedNodeId.value),
);

async function openNode(nodeId: string): Promise<void> {
  if (selectedNodeId.value === nodeId) {
    selectedNodeId.value = "";
    review.value = undefined;
    await resize();
    return;
  }
  selectedNodeId.value = nodeId;
  review.value = undefined;
  reviewError.value = "";
  rulesetBaseline.value = "";
  if (!canSeeReality.value) return;
  reviewLoading.value = true;
  try {
    const response = await call<ReviewResponse>("review", { node_id: nodeId });
    review.value = response.review;
    rulesetBaseline.value = response.review?.ruleset ?? "";
    reviewError.value = response.review?.compile_error ?? "";
  } catch (cause) {
    // A node with no compilable intent still has evidence worth reading, so a
    // failed review must not blank the panel.
    reviewError.value = safeErrorMessage(cause, "This node's review could not be loaded");
  } finally {
    reviewLoading.value = false;
    await resize();
  }
}

async function reloadReview(): Promise<void> {
  if (!selectedNodeId.value || !canSeeReality.value) return;
  try {
    const response = await call<ReviewResponse>("review", { node_id: selectedNodeId.value });
    review.value = response.review;
    reviewError.value = response.review?.compile_error ?? "";
  } catch (cause) {
    reviewError.value = safeErrorMessage(cause, "This node's review could not be reloaded");
  }
}

// ── loading ─────────────────────────────────────────────────────────────────

async function loadReality(): Promise<void> {
  if (!canSeeReality.value) {
    realityRows.value = [];
    return;
  }
  const collected: RealitySummary[] = [];
  let cursor = "";
  let truncated = false;
  for (let page = 0; page < REALITY_MAX_PAGES; page++) {
    const response = await call<RealityListResponse>("reality", {
      limit: REALITY_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    collected.push(...(response.nodes ?? []));
    cursor = response.next_cursor ?? "";
    if (!cursor) break;
    if (page === REALITY_MAX_PAGES - 1) truncated = true;
  }
  realityRows.value = collected;
  realityTruncated.value = truncated;
}

async function refresh(background = false): Promise<void> {
  if (!init.value) return;
  if (background) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  const failures: string[] = [];
  try {
    overview.value = await call<Overview>("overview");
  } catch (cause) {
    failures.push(safeErrorMessage(cause, "The NetGuard overview could not be loaded"));
  }
  try {
    await loadReality();
  } catch (cause) {
    failures.push(safeErrorMessage(cause, "Reality snapshots could not be loaded"));
  }
  // Partial failure is reported as partial, never rounded up to a working
  // panel: half this surface is intent and half is evidence, and a fleet
  // rendered from one of them alone is misleading.
  error.value = failures.join(" ");
  loading.value = false;
  refreshing.value = false;
  await resize();
}

// ── authoring ───────────────────────────────────────────────────────────────

const anchorTop = ref(0);
const groupDialog = ref(false);
const editingGroup = ref<SecurityGroup>();
const groupSaving = ref(false);
const groupError = ref("");

function openGroup(event: Event, group?: SecurityGroup): void {
  anchorTop.value = anchorTopFrom(event);
  editingGroup.value = group;
  groupError.value = "";
  groupDialog.value = true;
}

async function saveGroup(payload: Record<string, unknown>): Promise<void> {
  groupSaving.value = true;
  groupError.value = "";
  try {
    await call("upsert_group", payload);
    notice.value = `Security group ${String(payload.name)} saved`;
    groupDialog.value = false;
    await refresh(true);
    await reloadReview();
  } catch (cause) {
    groupError.value = safeErrorMessage(cause, "The security group could not be saved");
  } finally {
    groupSaving.value = false;
  }
}

const zoneDialog = ref(false);
const editingZone = ref<GuardZone>();
const zoneSaving = ref(false);
const zoneError = ref("");

function openZone(event: Event, zone?: GuardZone): void {
  anchorTop.value = anchorTopFrom(event);
  editingZone.value = zone;
  zoneError.value = "";
  zoneDialog.value = true;
}

async function saveZone(payload: Record<string, unknown>): Promise<void> {
  zoneSaving.value = true;
  zoneError.value = "";
  try {
    await call("upsert_zone", payload);
    notice.value = `Zone ${String(payload.name)} saved`;
    zoneDialog.value = false;
    await refresh(true);
    await reloadReview();
  } catch (cause) {
    zoneError.value = safeErrorMessage(cause, "The zone could not be saved");
  } finally {
    zoneSaving.value = false;
  }
}

const bindingDialog = ref(false);
const bindingSaving = ref(false);
const bindingError = ref("");

function openBinding(event: Event): void {
  anchorTop.value = anchorTopFrom(event);
  bindingError.value = "";
  bindingDialog.value = true;
}

async function saveBinding(payload: Record<string, unknown>): Promise<void> {
  bindingSaving.value = true;
  bindingError.value = "";
  try {
    await call("upsert_binding", payload);
    notice.value = `Binding for ${selectedRow.value?.nodeName ?? "node"} saved`;
    bindingDialog.value = false;
    await refresh(true);
    await reloadReview();
  } catch (cause) {
    bindingError.value = safeErrorMessage(cause, "The node binding could not be saved");
  } finally {
    bindingSaving.value = false;
  }
}

async function adopt(): Promise<void> {
  if (!selectedRow.value) return;
  try {
    await call("adopt", { node_id: selectedRow.value.nodeId });
    notice.value = `${selectedRow.value.nodeName} adopted into NetGuard`;
    await refresh(true);
    await reloadReview();
  } catch (cause) {
    error.value = safeErrorMessage(cause, "The legacy baseline could not be adopted");
  }
}

// ── delete ──────────────────────────────────────────────────────────────────

const deleteTarget = ref<{ type: "group" | "zone"; id: string; label: string }>();
const deleteError = ref("");
const deleting = ref(false);

function askDelete(event: Event, type: "group" | "zone", id: string, label: string): void {
  anchorTop.value = anchorTopFrom(event);
  deleteError.value = "";
  deleteTarget.value = { type, id, label };
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    await call(deleteTarget.value.type === "group" ? "delete_group" : "delete_zone", {
      id: deleteTarget.value.id,
    });
    notice.value = `${deleteTarget.value.label} deleted`;
    deleteTarget.value = undefined;
    await refresh(true);
    await reloadReview();
  } catch (cause) {
    deleteError.value = safeErrorMessage(
      cause,
      "It could not be deleted. A node may still reference it.",
    );
  } finally {
    deleting.value = false;
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

const applyDialog = ref(false);
const planning = ref(false);
const planError = ref("");

function openApply(event: Event): void {
  anchorTop.value = anchorTopFrom(event);
  planError.value = "";
  applyDialog.value = true;
}

async function confirmApply(acceptLockoutRisk: boolean): Promise<void> {
  if (!selectedRow.value) return;
  planning.value = true;
  planError.value = "";
  try {
    const result = await call<{ approval: { id: string } }>("plan", {
      node_id: selectedRow.value.nodeId,
      accept_lockout_risk: acceptLockoutRisk,
    });
    notice.value = `Approval ${result.approval?.id ?? ""} created for ${selectedRow.value.nodeName}. It applies once approved.`;
    applyDialog.value = false;
    await refresh(true);
    await reloadReview();
    rulesetBaseline.value = review.value?.ruleset ?? rulesetBaseline.value;
  } catch (cause) {
    planError.value = safeErrorMessage(cause, "The plan was refused or could not be created");
  } finally {
    planning.value = false;
  }
}

// ── host plumbing ───────────────────────────────────────────────────────────

const dialogOpen = computed(
  () =>
    groupDialog.value || zoneDialog.value || bindingDialog.value || applyDialog.value || Boolean(deleteTarget.value),
);

async function resize(): Promise<void> {
  await nextTick();
  bridge?.resize(document.documentElement.scrollHeight);
}

watch([visibleRows, tab, selectedNodeId, dialogOpen], () => void resize());

let observer: ResizeObserver | undefined;
let poller: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  observer = new ResizeObserver(() => void resize());
  observer.observe(document.body);
  // Never refresh while the operator is working. A background reload re-sorts
  // the fleet and changes the page height, which moves rows under the pointer:
  // in a panel whose rows open a node and whose buttons apply a firewall, that
  // is how the wrong node gets clicked. Reading a diff or a node's evidence
  // pauses the poll, and the Refresh button is always there.
  poller = setInterval(() => {
    if (!loading.value && !dialogOpen.value && !selectedNodeId.value) void refresh(true);
  }, 30_000);
  void resize();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (poller) clearInterval(poller);
  bridge?.dispose();
});

function ruleSummary(rule: GuardRule): string {
  const ports = formatRanges(rule.ports) || "all ports";
  const remote = remoteValue(rule.remote) || rule.remote.kind;
  return `${rule.protocol} ${ports} from ${remote}`;
}
</script>

<template>
  <main class="workspace">
    <header class="masthead">
      <div class="mark"><Shield :size="18" /></div>
      <div class="mark-copy">
        <h1>NetGuard</h1>
        <p>nftables firewall control for the fleet: what you declared, and what each machine reports it actually has.</p>
      </div>
      <button class="button secondary" type="button" :disabled="loading || refreshing" @click="refresh(true)">
        <LoaderCircle v-if="refreshing" class="spin" :size="15" /><RefreshCw v-else :size="15" />Refresh
      </button>
    </header>

    <div v-if="bootError" class="notice danger" role="alert">
      <CircleAlert :size="16" /><span>{{ bootError }}</span>
    </div>
    <div v-if="error" class="notice danger" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss" @click="error = ''"><X :size="14" /></button>
    </div>
    <div v-if="notice" class="notice ok" aria-live="polite">
      <CheckCircle2 :size="16" /><span>{{ notice }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss" @click="notice = ''"><X :size="14" /></button>
    </div>
    <div v-if="realityTruncated" class="notice warn">
      <CircleAlert :size="16" />
      <span>
        This fleet is larger than this panel paged through, so the posture below covers only the
        nodes listed. Narrow the view before trusting the totals.
      </span>
    </div>
    <div v-if="!canSeeReality && !loading" class="notice warn">
      <CircleAlert :size="16" />
      <span>
        This session cannot read node reality, so drift cannot be shown. Everything below is declared
        intent only.
      </span>
    </div>

    <nav class="tabs" role="tablist" aria-label="NetGuard">
      <button type="button" role="tab" :aria-selected="tab === 'fleet'" @click="tab = 'fleet'">
        <Shield :size="14" />Fleet<span>{{ counts.total }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'groups'" @click="tab = 'groups'">
        <Boxes :size="14" />Security groups<span>{{ overview.groups.length }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'zones'" @click="tab = 'zones'">
        <ShieldCheck :size="14" />Trusted zones<span>{{ overview.zones.length }}</span>
      </button>
    </nav>

    <div v-if="loading" class="loading"><LoaderCircle class="spin" :size="20" />Loading firewall state</div>

    <template v-else-if="tab === 'fleet'">
      <PostureBar :counts="counts" :active="filter" @select="filter = $event" />

      <div class="toolbar">
        <label class="search">
          <span class="visually-hidden">Search nodes</span>
          <input v-model="search" type="search" placeholder="Search by node, group or zone" />
        </label>
        <p class="subtle">
          Showing {{ visibleRows.length }} of {{ counts.total }} {{ counts.total === 1 ? 'node' : 'nodes' }}
        </p>
      </div>

      <FleetTable
        :rows="visibleRows"
        :sort-key="sortKey"
        :sort-direction="sortDirection"
        :selected="selectedNodeId"
        :loading="loading"
        @sort="onSort"
        @open="openNode"
      />

      <NodeDetail
        v-if="selectedRow"
        :row="selectedRow"
        :review="review"
        :loading="reviewLoading"
        :review-error="reviewError"
        :can-admin="canAdmin"
        :can-plan="canPlan"
        @edit-binding="openBinding"
        @plan="openApply"
        @adopt="adopt"
      />
    </template>

    <template v-else-if="tab === 'groups'">
      <div class="toolbar">
        <div>
          <h2>Security groups</h2>
          <p class="subtle">Ordered rules, attached to one or more nodes. The chain policy stays default drop.</p>
        </div>
        <button v-if="canAdmin" class="button primary" type="button" @click="openGroup($event)">
          <Plus :size="14" />New group
        </button>
      </div>

      <section v-if="overview.groups.length" class="panel">
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Group</th><th>Rules</th><th>Source</th><th class="numeric">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="group in overview.groups" :key="group.id">
                <td>
                  <strong>{{ group.name }}</strong>
                  <small class="mono">{{ group.id }}</small>
                </td>
                <td>
                  <p v-if="!group.rules?.length" class="absent">No rules. Everything stays dropped.</p>
                  <ul v-else class="rule-summary">
                    <li v-for="rule in group.rules" :key="rule.id" :data-disabled="rule.disabled">
                      <span class="rule-action" :data-action="rule.action">{{ rule.action }}</span>
                      <span class="mono">{{ ruleSummary(rule) }}</span>
                      <small v-if="rule.comment">{{ rule.comment }}</small>
                    </li>
                  </ul>
                </td>
                <td>{{ group.source || 'stored' }}<small>v{{ group.version }}</small></td>
                <td class="numeric">
                  <div v-if="canAdmin" class="actions">
                    <button class="icon-button bordered" type="button" aria-label="Edit group" @click="openGroup($event, group)">
                      <Pencil :size="14" />
                    </button>
                    <button
                      class="icon-button bordered destructive"
                      type="button"
                      aria-label="Delete group"
                      @click="askDelete($event, 'group', group.id, group.name)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div v-else class="empty panel">
        <Boxes :size="26" />
        <strong>No security groups</strong>
        <span>Create a reusable rule set, then attach it to a managed node.</span>
      </div>
    </template>

    <template v-else>
      <div class="toolbar">
        <div>
          <h2>Trusted zones</h2>
          <p class="subtle">Interfaces and CIDRs accepted before any security group is evaluated.</p>
        </div>
        <button v-if="canAdmin" class="button primary" type="button" @click="openZone($event)">
          <Plus :size="14" />New zone
        </button>
      </div>

      <section class="panel">
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Zone</th><th>Interfaces</th><th>CIDRs</th><th>Kind</th><th class="numeric">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="zone in overview.zones" :key="zone.id">
                <td>
                  <strong>{{ zone.name }}</strong>
                  <small>{{ zone.description || zone.id }}</small>
                </td>
                <td class="mono">{{ zone.interfaces?.join(', ') || 'resolved per node' }}</td>
                <td class="mono">{{ zone.cidrs?.join(', ') || 'resolved per node' }}</td>
                <td>{{ zone.builtin ? 'built in' : 'custom' }}</td>
                <td class="numeric">
                  <div v-if="canAdmin && !zone.builtin" class="actions">
                    <button class="icon-button bordered" type="button" aria-label="Edit zone" @click="openZone($event, zone)">
                      <Pencil :size="14" />
                    </button>
                    <button
                      class="icon-button bordered destructive"
                      type="button"
                      aria-label="Delete zone"
                      @click="askDelete($event, 'zone', zone.id, zone.name)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </div>
                  <span v-else class="absent">built in</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <GroupEditor
      :open="groupDialog"
      :anchor-top="anchorTop"
      :group="editingGroup"
      :saving="groupSaving"
      :error="groupError"
      @close="groupDialog = false"
      @save="saveGroup"
    />
    <ZoneEditor
      :open="zoneDialog"
      :anchor-top="anchorTop"
      :zone="editingZone"
      :saving="zoneSaving"
      :error="zoneError"
      @close="zoneDialog = false"
      @save="saveZone"
    />
    <BindingEditor
      :open="bindingDialog"
      :anchor-top="anchorTop"
      :node="selectedRow?.intent"
      :groups="overview.groups"
      :zones="overview.zones"
      :saving="bindingSaving"
      :error="bindingError"
      @close="bindingDialog = false"
      @save="saveBinding"
    />
    <ApplyDialog
      :open="applyDialog"
      :anchor-top="anchorTop"
      :row="selectedRow"
      :baseline="rulesetBaseline"
      :ruleset="review?.ruleset ?? ''"
      :findings="review?.findings ?? []"
      :compile-error="reviewError"
      :planning="planning"
      :error="planError"
      @close="applyDialog = false"
      @confirm="confirmApply"
    />

    <AnchoredOverlay
      :open="Boolean(deleteTarget)"
      :anchor-top="anchorTop"
      :busy="deleting"
      width="narrow"
      :title="`Delete ${deleteTarget?.label ?? ''}`"
      @close="deleteTarget = undefined"
    >
      <p>
        This removes <strong>{{ deleteTarget?.label }}</strong> from NetGuard. Nodes that still
        reference it keep their current rules until they are planned again.
      </p>
      <p v-if="deleteError" class="notice danger"><span>{{ deleteError }}</span></p>
      <template #footer>
        <button class="button secondary" type="button" :disabled="deleting" @click="deleteTarget = undefined">
          Cancel
        </button>
        <button class="button danger" type="button" :disabled="deleting" @click="confirmDelete">
          <LoaderCircle v-if="deleting" class="spin" :size="14" />Delete
        </button>
      </template>
    </AnchoredOverlay>
  </main>
</template>
