<script setup lang="ts">
/**
 * NetGuard: a firewall control plane for a fleet of small nodes.
 *
 * The surface is organised around one question, asked in this order: what is
 * open to the internet right now and on which node (the exposure lens), what
 * should be allowed (groups and zones), and what exactly will change if I
 * apply (the per-node review and its diff).
 *
 * Two constraints shape everything below. The frame the host renders this in
 * is a viewport the host sizes itself, so this document is the one scroller
 * and overlays are fixed against the window; nothing here measures the page
 * or reports a height. And every state has to be honest, because a firewall
 * panel that renders an unreported node as a healthy one is worse than no
 * panel at all.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
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

import ApplyDialog from "./components/ApplyDialog.vue";
import BindingEditor from "./components/BindingEditor.vue";
import ExposureFindings from "./components/ExposureFindings.vue";
import ExposureTable, { type DetailState, type ExposureRowView } from "./components/ExposureTable.vue";
import GroupEditor from "./components/GroupEditor.vue";
import ModalDialog from "./components/ModalDialog.vue";
import NodeDetail from "./components/NodeDetail.vue";
import ZoneEditor from "./components/ZoneEditor.vue";
import {
  allowsPreview,
  compareExposure,
  computeExposure,
  draftRuleFor,
  findingsFor,
  formatProcesses,
  newestCollectedAt,
  ruleSentence,
  usedByNodes,
  type ExposureContext,
  type ExposureSortKey,
  type Finding,
  type KnockGate,
} from "./exposure";
import { countPosture, joinPosture, type PostureRow } from "./posture";
import {
  endSentence,
  safeErrorMessage,
  toWire,
  type GuardNodeReality,
  type GuardRule,
  type GuardZone,
  type Overview,
  type RealityDetailResponse,
  type RealityListResponse,
  type RealitySummary,
  type Review,
  type ReviewResponse,
  type SecurityGroup,
} from "./netguardModel";
import { scrollToElement } from "./scrollTo";
import { ageLabel, clockUtc, stampUtc } from "./time";

const SERVICE = "latticenet.netguard/firewall";
/**
 * The fleet list is paginated. Following the cursor is not optional: stopping
 * at the first page would silently drop nodes from a firewall inventory, and
 * the resulting counts would be confidently wrong. The bound exists so a
 * broken cursor cannot spin forever.
 */
const REALITY_PAGE_LIMIT = 200;
const REALITY_MAX_PAGES = 50;
/**
 * The fleet list carries counts, not sockets, so the exposure column needs
 * one detail call per reporting node. Six in flight keeps a 33 node fleet
 * under a second without queueing behind the bridge's per-call timeout.
 */
const DETAIL_CONCURRENCY = 6;
/** 50 rows is a screen and a half at 40px; the pager takes over past it. */
const NODE_PAGE_SIZE = 50;

type Lens = "exposure" | "groups" | "zones";
const LENSES: readonly Lens[] = ["exposure", "groups", "zones"];

const init = ref<HostInit>();
const overview = ref<Overview>({ nodes: [], groups: [], zones: [] });
const realityRows = ref<RealitySummary[]>([]);
const realityTruncated = ref(false);
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const bootError = ref("");

/* The plugin document's own query string can open a lens, a search or a node,
 * so a host, a reviewer or an agent can deep-link a state (`?lens=groups`,
 * `?q=postgres`, `?node=…`). The nonce lives in the fragment and is left alone. */
const documentQuery = new URLSearchParams(window.location.search);
const requestedLens = documentQuery.get("lens");
const lens = ref<Lens>(LENSES.includes(requestedLens as Lens) ? (requestedLens as Lens) : "exposure");
const search = ref(documentQuery.get("q") ?? "");
const selectedNodeId = ref(documentQuery.get("node") ?? "");

watch([lens, search, selectedNodeId], () => {
  try {
    const url = new URL(window.location.href);
    const set = (key: string, value: string) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    set("lens", lens.value === "exposure" ? "" : lens.value);
    set("q", search.value.trim());
    set("node", selectedNodeId.value);
    window.history.replaceState(null, "", url);
  } catch {
    // A sandbox that refuses history writes still renders; the link is a convenience.
  }
});

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
      bootError.value = safeErrorMessage(
        cause,
        "The Lattice console did not hand this page a session, so NetGuard has nothing to show.",
      );
      loading.value = false;
    });
} catch (cause) {
  bootError.value = safeErrorMessage(
    cause,
    "The Lattice console did not hand this page a session, so NetGuard has nothing to show.",
  );
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
    throw new Error(`This session cannot run ${method} on NetGuard, so nothing was sent to any node.`);
  }
  // toWire, not the payload as given: these payloads are assembled from
  // reactive forms, and postMessage cannot structured-clone a Vue proxy.
  return bridge.call<T>(SERVICE, method, toWire(payload)).promise;
}

// ── evidence ────────────────────────────────────────────────────────────────

/** Full snapshots by node, fetched after the fleet list so the table paints first. */
const realityByNode = ref(new Map<string, GuardNodeReality>());
/** Knock gates with a known scope, by node; a gate the detail cannot scope is not listed. */
const knockByNode = ref(new Map<string, KnockGate>());
const detailState = ref(new Map<string, DetailState>());
const detailProgress = ref({ done: 0, total: 0 });
/**
 * The instant the page last fetched. Every age on the page is measured against
 * it rather than against a ticking clock, so an age is true of the observation
 * it describes and the proof line says when that was.
 */
const observedAt = ref(0);
let refreshEpoch = 0;

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

async function loadDetails(epoch: number): Promise<void> {
  const targets = realityRows.value.filter((row) => row.snapshot_status !== "unknown").map((row) => row.node_id);
  realityByNode.value = new Map();
  knockByNode.value = new Map();
  detailState.value = new Map();
  detailProgress.value = { done: 0, total: targets.length };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length && epoch === refreshEpoch) {
      const nodeId = targets[next++]!;
      try {
        const response = await call<RealityDetailResponse>("reality", { node_id: nodeId });
        if (epoch !== refreshEpoch) return;
        const reality = response.node?.reality ?? undefined;
        if (reality) realityByNode.value.set(nodeId, reality);
        const gated = response.node?.knock_gate ? (response.node.knock_gated_ports ?? []) : [];
        if (gated.length) knockByNode.value.set(nodeId, { ports: gated });
        detailState.value.set(nodeId, reality ? "loaded" : "failed");
      } catch {
        if (epoch !== refreshEpoch) return;
        // One unreadable snapshot is one "unknown" cell, never a blank fleet.
        detailState.value.set(nodeId, "failed");
      } finally {
        if (epoch === refreshEpoch) detailProgress.value = { ...detailProgress.value, done: detailProgress.value.done + 1 };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, targets.length) }, worker));
}

async function refresh(background = false): Promise<void> {
  if (!init.value) return;
  const epoch = ++refreshEpoch;
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
  if (epoch !== refreshEpoch) return;
  // Partial failure is reported as partial, never rounded up to a working
  // panel: half this surface is intent and half is evidence, and a fleet
  // rendered from one of them alone is misleading. One failure per line.
  error.value = failures.map(endSentence).join("\n");
  observedAt.value = Date.now();
  loading.value = false;
  refreshing.value = false;
  // A node opened by URL needs its review the same way a clicked one does.
  if (!background && selectedNodeId.value) void loadSelectedReview();
  await loadDetails(epoch);
}

// ── the exposure lens ───────────────────────────────────────────────────────

const posture = computed(() => joinPosture(overview.value.nodes, realityRows.value));
const counts = computed(() => countPosture(posture.value));
const exposureContext = computed<ExposureContext>(() => ({
  groups: overview.value.groups,
  zones: overview.value.zones,
  nodeNames: new Map(posture.value.map((row) => [row.nodeId, row.nodeName])),
}));

function detailStateFor(row: PostureRow): DetailState {
  if (row.snapshotStatus === "unknown") return "loaded";
  return detailState.value.get(row.nodeId) ?? "pending";
}

const views = computed<ExposureRowView[]>(() =>
  posture.value.map((row) => ({
    row,
    exposure: computeExposure(row, realityByNode.value.get(row.nodeId), exposureContext.value, knockByNode.value.get(row.nodeId)),
    detail: detailStateFor(row),
  })),
);

const sortKey = ref<ExposureSortKey>("attention");
const sortDirection = ref<"asc" | "desc">("asc");

function onSort(key: ExposureSortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = "asc";
}

/** Node, id, group and zone ids, group names and the open ports themselves. */
function matchesSearch(view: ExposureRowView, needle: string): boolean {
  const haystack = [
    view.row.nodeId,
    view.row.nodeName,
    ...view.row.groupIds,
    ...view.row.zoneIds,
    ...(view.exposure.managedBy.kind === "none" ? [] : view.exposure.managedBy.names),
    ...view.exposure.open.map((span) => `${span.from} ${span.to} ${formatProcesses(span)}`),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

const searching = computed(() => search.value.trim().length > 0);
const matchedViews = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const matched = needle ? views.value.filter((view) => matchesSearch(view, needle)) : [...views.value];
  const factor = sortDirection.value === "desc" ? -1 : 1;
  return matched.sort(
    (a, b) => compareExposure(a, b, sortKey.value) * factor || a.row.nodeId.localeCompare(b.row.nodeId),
  );
});

const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(matchedViews.value.length / NODE_PAGE_SIZE)));
const pageViews = computed(() => {
  const start = (Math.min(page.value, pageCount.value) - 1) * NODE_PAGE_SIZE;
  return matchedViews.value.slice(start, start + NODE_PAGE_SIZE);
});
watch(search, () => {
  page.value = 1;
});

const newestObserved = computed(() => newestCollectedAt(posture.value));
const proofTitle = computed(() => {
  if (!observedAt.value) return "";
  const fetched = `This page fetched at ${clockUtc(observedAt.value)}; every age is measured from then.`;
  return newestObserved.value
    ? `Newest node snapshot ${stampUtc(newestObserved.value)}. ${fetched} Refresh to observe again.`
    : `No node has reported a snapshot. ${fetched}`;
});
const readingSnapshots = computed(
  () => detailProgress.value.total > 0 && detailProgress.value.done < detailProgress.value.total,
);

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Session-local dismissals. Deliberately not persisted, reversible from the
 * row, and never subtracted from the count: an ignored finding is still an
 * open port, so the badge and the subtitle keep counting it and say how many
 * are ignored beside it.
 */
const ignored = ref(new Set<string>());
const expandedFindings = ref(new Set<string>());

const findings = computed<Finding[]>(() =>
  matchedViews.value
    .filter((view) => view.detail === "loaded" && view.exposure.evidence === "fresh")
    .flatMap((view) => findingsFor(view.row, view.exposure, exposureContext.value)),
);

function toggleFinding(key: string): void {
  if (expandedFindings.value.has(key)) {
    expandedFindings.value.delete(key);
    return;
  }
  expandedFindings.value.add(key);
  const finding = findings.value.find((candidate) => candidate.key === key);
  if (finding) void ensureReview(finding.nodeId);
}

async function focusFinding(key: string): Promise<void> {
  ignored.value.delete(key);
  if (!expandedFindings.value.has(key)) toggleFinding(key);
  await nextTick();
  scrollToElement(document.getElementById(`finding-${key}`));
}

function ignoreFinding(key: string): void {
  ignored.value.add(key);
  expandedFindings.value.delete(key);
}

function restoreFinding(key: string): void {
  ignored.value.delete(key);
}

const emptyMessage = computed(() =>
  searching.value ? "No node matches the search. Clear it to see the fleet." : "This session can see no nodes at all.",
);

function addToGroup(finding: Finding): void {
  const view = views.value.find((candidate) => candidate.row.nodeId === finding.nodeId);
  const managed = view?.exposure.managedBy;
  let target: SecurityGroup | undefined;
  if (managed?.kind === "groups") {
    const firstBound = view?.row.intent?.binding?.group_ids?.[0];
    target = overview.value.groups.find((group) => group.id === firstBound);
  }
  groupDraft.value = {
    rules: [draftRuleFor(finding)],
    name: formatProcesses(finding.span) || finding.nodeName,
  };
  openGroup(target);
}

// ── reviews (per node, on demand) ───────────────────────────────────────────

const reviews = ref(new Map<string, Review>());
const reviewLoading = ref(new Set<string>());
const reviewErrors = ref(new Map<string, string>());
/**
 * The ruleset as it stood when the selected node was opened. It is the left
 * side of the apply diff: the only "before" a client can honestly show,
 * because a reality snapshot reports the live table as a hash, never as text.
 */
const rulesetBaseline = ref("");

async function ensureReview(nodeId: string, force = false): Promise<void> {
  if (!canSeeReality.value || !nodeId) return;
  if (!force && (reviews.value.has(nodeId) || reviewLoading.value.has(nodeId))) return;
  reviewLoading.value.add(nodeId);
  try {
    const response = await call<ReviewResponse>("review", { node_id: nodeId });
    reviews.value.set(nodeId, response.review);
    reviewErrors.value.delete(nodeId);
  } catch (cause) {
    // A node with no compilable intent still has evidence worth reading, so a
    // failed review must not blank the panel.
    reviewErrors.value.set(nodeId, safeErrorMessage(cause, "This node's review could not be loaded"));
  } finally {
    reviewLoading.value.delete(nodeId);
  }
}

const selectedRow = computed<PostureRow | undefined>(() =>
  posture.value.find((row) => row.nodeId === selectedNodeId.value),
);
const selectedReview = computed(() => reviews.value.get(selectedNodeId.value));
const selectedReviewError = computed(
  () => selectedReview.value?.compile_error || reviewErrors.value.get(selectedNodeId.value) || "",
);

/** A fresh review for the selected node, and the diff baseline it opened with. */
async function loadSelectedReview(): Promise<void> {
  const nodeId = selectedNodeId.value;
  rulesetBaseline.value = "";
  await ensureReview(nodeId, true);
  if (selectedNodeId.value === nodeId) rulesetBaseline.value = reviews.value.get(nodeId)?.ruleset ?? "";
}

async function openNode(nodeId: string): Promise<void> {
  if (selectedNodeId.value === nodeId) {
    selectedNodeId.value = "";
    return;
  }
  selectedNodeId.value = nodeId;
  // The panel mounts under the table, which on a full fleet is below the
  // fold; a click whose only visible effect is a 2px bar is a click that did
  // nothing. Bring the panel up on the base duration.
  await nextTick();
  scrollToElement(document.querySelector<HTMLElement>(".detail"));
  await loadSelectedReview();
}

async function reloadReview(): Promise<void> {
  if (selectedNodeId.value) await ensureReview(selectedNodeId.value, true);
}

// ── authoring ───────────────────────────────────────────────────────────────

const groupDialog = ref(false);
const editingGroup = ref<SecurityGroup>();
const groupDraft = ref<{ rules: GuardRule[]; name: string }>();
const groupSaving = ref(false);
const groupError = ref("");

function openGroup(group?: SecurityGroup): void {
  editingGroup.value = group;
  groupError.value = "";
  groupDialog.value = true;
}

function closeGroup(): void {
  groupDialog.value = false;
  groupDraft.value = undefined;
}

async function saveGroup(payload: Record<string, unknown>): Promise<void> {
  groupSaving.value = true;
  groupError.value = "";
  try {
    await call("upsert_group", payload);
    notice.value = `Security group ${String(payload.name)} saved`;
    closeGroup();
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

function openZone(zone?: GuardZone): void {
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

function openBinding(): void {
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

function askDelete(type: "group" | "zone", id: string, label: string): void {
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

// ── apply (per node: the review, the diff, the approval) ────────────────────

const applyDialog = ref(false);
const planning = ref(false);
const planError = ref("");

function openApply(): void {
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
    const approvalId = result.approval?.id ?? "";
    notice.value = `Approval created for ${selectedRow.value.nodeName}${approvalId ? ` (${approvalId})` : ""}. The node keeps its current rules until someone approves it.`;
    applyDialog.value = false;
    await refresh(true);
    await reloadReview();
    rulesetBaseline.value = selectedReview.value?.ruleset ?? rulesetBaseline.value;
  } catch (cause) {
    planError.value = safeErrorMessage(
      cause,
      "NetGuard did not create the plan. Nothing has changed on this node.",
    );
  } finally {
    planning.value = false;
  }
}

// ── host plumbing ───────────────────────────────────────────────────────────
//
// Nothing here measures this document's height or polls. The host frame is a
// viewport the host sizes itself, so a page that reported its own height was
// running a full synchronous layout on every body resize and throwing the
// answer away. And a background reload re-sorts the fleet and moves rows under
// the pointer: in a panel whose rows open a node and whose buttons apply a
// firewall, that is how the wrong node gets clicked. Refresh is a button.

onBeforeUnmount(() => {
  bridge?.dispose();
});

// ── groups and zones ────────────────────────────────────────────────────────

/** The merged preview, only where merging says something the rule list does not. */
function groupPreview(group: SecurityGroup): string[] {
  const rules = group.rules ?? [];
  const preview = allowsPreview(rules, exposureContext.value);
  const enabledAllows = rules.filter((rule) => !rule.disabled && rule.action === "allow" && rule.direction === "ingress").length;
  return preview.length < enabledAllows ? preview : [];
}

function groupUsedBy(group: SecurityGroup): number {
  return usedByNodes(overview.value.nodes, "group_ids", group.id);
}

function zoneUsedBy(zone: GuardZone): number {
  return usedByNodes(overview.value.nodes, "zone_ids", zone.id);
}

function nodesWord(count: number): string {
  return count === 1 ? "node" : "nodes";
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

    <p v-if="!loading && !bootError" class="proof-line" aria-live="polite" :title="proofTitle">
      <span v-if="newestObserved">observed {{ clockUtc(newestObserved) }}, {{ ageLabel(newestObserved, observedAt) }} ago</span>
      <span v-else-if="canSeeReality">not observed yet</span>
      <span v-else>reality not readable</span>
      <span>· {{ counts.total }} {{ nodesWord(counts.total) }}</span>
      <span>· {{ counts.managed }} managed</span>
      <span>· {{ counts.observeOnly }} observe only</span>
      <span>· {{ counts.drifted }} drift</span>
      <span>· {{ counts.stale }} stale</span>
      <span v-if="readingSnapshots">· reading {{ detailProgress.done }} of {{ detailProgress.total }} snapshots</span>
      <span v-if="refreshing">· refreshing</span>
    </p>

    <div v-if="bootError" class="notice danger" role="alert">
      <CircleAlert :size="16" /><span>{{ bootError }}</span>
    </div>
    <div v-if="error" class="notice danger" role="alert">
      <CircleAlert :size="16" /><span class="pre-line">{{ error }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss" @click="error = ''"><X :size="14" /></button>
    </div>
    <div v-if="notice" class="notice ok" aria-live="polite">
      <CheckCircle2 :size="16" /><span>{{ notice }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss" @click="notice = ''"><X :size="14" /></button>
    </div>
    <div v-if="realityTruncated" class="notice warn">
      <CircleAlert :size="16" />
      <span>
        This fleet is larger than this panel paged through, so the exposure below covers only the
        nodes listed. Narrow the view before trusting the totals.
      </span>
    </div>
    <div v-if="!canSeeReality && !loading && !bootError" class="notice warn">
      <CircleAlert :size="16" />
      <span>
        This session cannot read node reality, so exposure and drift cannot be shown. Everything
        below is declared intent only.
      </span>
    </div>

    <nav class="lens-switch" role="tablist" aria-label="NetGuard lens">
      <button class="lens-tab" type="button" role="tab" :aria-selected="lens === 'exposure'" @click="lens = 'exposure'">
        <Shield :size="14" />Exposure
        <span v-if="findings.length" class="lens-count" data-tone="danger">{{ findings.length }}</span>
      </button>
      <button class="lens-tab" type="button" role="tab" :aria-selected="lens === 'groups'" @click="lens = 'groups'">
        <Boxes :size="14" />Groups<span class="lens-count">{{ overview.groups.length }}</span>
      </button>
      <button class="lens-tab" type="button" role="tab" :aria-selected="lens === 'zones'" @click="lens = 'zones'">
        <ShieldCheck :size="14" />Zones<span class="lens-count">{{ overview.zones.length }}</span>
      </button>
    </nav>

    <div v-if="loading" class="loading"><LoaderCircle class="spin" :size="20" />Loading firewall state</div>

    <template v-else-if="lens === 'exposure'">
      <div class="toolbar">
        <label class="search">
          <span class="visually-hidden">Search nodes</span>
          <input v-model="search" type="search" placeholder="Search by node, group, zone, port or process" />
        </label>
        <p class="subtle">
          <template v-if="searching">{{ matchedViews.length }} of {{ counts.total }} {{ nodesWord(counts.total) }} match</template>
          <template v-else>{{ counts.total }} {{ nodesWord(counts.total) }}</template>
          <template v-if="pageCount > 1">
            · page {{ Math.min(page, pageCount) }} of {{ pageCount }}
            <button class="button ghost compact" type="button" :disabled="page <= 1" @click="page -= 1">Previous</button>
            <button class="button ghost compact" type="button" :disabled="page >= pageCount" @click="page += 1">Next</button>
          </template>
        </p>
      </div>

      <ExposureTable
        :rows="pageViews"
        :sort-key="sortKey"
        :sort-direction="sortDirection"
        :selected="selectedNodeId"
        :ignored="ignored"
        :observed-at="observedAt"
        :can-see-reality="canSeeReality"
        :error="error"
        :empty-message="emptyMessage"
        @sort="onSort"
        @open="openNode"
        @finding="focusFinding"
        @refresh="refresh(true)"
      />

      <NodeDetail
        v-if="selectedRow"
        :row="selectedRow"
        :review="selectedReview"
        :loading="reviewLoading.has(selectedNodeId)"
        :review-error="selectedReviewError"
        :can-admin="canAdmin"
        :can-plan="canPlan"
        @edit-binding="openBinding"
        @plan="openApply"
        @adopt="adopt"
      />

      <ExposureFindings
        :findings="findings"
        :expanded="expandedFindings"
        :ignored="ignored"
        :reviews="reviews"
        :review-loading="reviewLoading"
        :review-errors="reviewErrors"
        :can-admin="canAdmin"
        @toggle="toggleFinding"
        @add="addToGroup"
        @ignore="ignoreFinding"
        @restore="restoreFinding"
      />
    </template>

    <template v-else-if="lens === 'groups'">
      <div class="toolbar">
        <div>
          <h2>Security groups</h2>
          <p class="subtle">Ordered rules, attached to one or more nodes. The chain policy stays default drop.</p>
        </div>
        <button v-if="canAdmin" class="button primary" type="button" @click="openGroup()">
          <Plus :size="14" />New group
        </button>
      </div>

      <section v-if="overview.groups.length" class="panel">
        <div class="table-scroll">
          <table class="groups-table">
            <thead>
              <tr><th>Group</th><th>Rules</th><th class="numeric">Used by</th><th>Source</th><th class="actions-head"><span class="visually-hidden">Actions</span></th></tr>
            </thead>
            <tbody>
              <tr v-for="group in overview.groups" :key="group.id">
                <td class="node-cell">
                  <strong>{{ group.name }}</strong>
                  <small class="mono">{{ group.id }}</small>
                  <small v-for="line in groupPreview(group)" :key="line" class="allows-line">allows {{ line }}</small>
                </td>
                <td>
                  <p v-if="!group.rules?.length" class="absent">No rules. Everything stays dropped.</p>
                  <ul v-else class="rule-summary">
                    <li v-for="rule in group.rules" :key="rule.id" :data-disabled="rule.disabled">
                      <span class="rule-action" :data-action="rule.action">{{ rule.disabled ? 'off' : rule.action }}</span>
                      <span class="mono">{{ ruleSentence(rule, exposureContext) }}</span>
                      <small v-if="rule.comment">{{ rule.comment }}</small>
                    </li>
                  </ul>
                </td>
                <td class="numeric mono">
                  {{ groupUsedBy(group) }}
                  <small>{{ nodesWord(groupUsedBy(group)) }}</small>
                </td>
                <td>{{ group.source || 'stored' }}<small>v{{ group.version }}</small></td>
                <td class="actions-cell">
                  <span v-if="canAdmin" class="row-actions">
                    <button class="icon-button bordered" type="button" aria-label="Edit group" title="Edit" @click="openGroup(group)">
                      <Pencil :size="14" />
                    </button>
                    <button
                      class="icon-button bordered destructive"
                      type="button"
                      aria-label="Delete group"
                      title="Delete"
                      @click="askDelete('group', group.id, group.name)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </span>
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
        <button v-if="canAdmin" class="button primary" type="button" @click="openZone()">
          <Plus :size="14" />New zone
        </button>
      </div>

      <section v-if="overview.zones.length" class="panel">
        <div class="table-scroll">
          <table class="zones-table">
            <thead>
              <tr><th>Zone</th><th>Interfaces</th><th>CIDRs</th><th>Kind</th><th class="numeric">Used by</th><th class="actions-head"><span class="visually-hidden">Actions</span></th></tr>
            </thead>
            <tbody>
              <tr v-for="zone in overview.zones" :key="zone.id">
                <td class="node-cell">
                  <strong>{{ zone.name }}</strong>
                  <small>{{ zone.description || zone.id }}</small>
                </td>
                <td class="mono">{{ zone.interfaces?.join(', ') || (zone.builtin ? 'resolved per node' : 'none set') }}</td>
                <td class="mono">{{ zone.cidrs?.join(', ') || (zone.builtin ? 'resolved per node' : 'none set') }}</td>
                <td>{{ zone.builtin ? 'built in' : 'custom' }}</td>
                <td class="numeric mono">
                  {{ zoneUsedBy(zone) }}
                  <small>{{ nodesWord(zoneUsedBy(zone)) }}</small>
                </td>
                <td class="actions-cell">
                  <span v-if="canAdmin && !zone.builtin" class="row-actions">
                    <button class="icon-button bordered" type="button" aria-label="Edit zone" title="Edit" @click="openZone(zone)">
                      <Pencil :size="14" />
                    </button>
                    <button
                      class="icon-button bordered destructive"
                      type="button"
                      aria-label="Delete zone"
                      title="Delete"
                      @click="askDelete('zone', zone.id, zone.name)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </span>
                  <span v-else class="absent">built in</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div v-else class="empty panel">
        <ShieldCheck :size="26" />
        <strong>No trusted zones</strong>
        <span>
          A zone names the interfaces and CIDRs a node accepts before any security group runs. Create
          one to keep a management path open, then attach it in a node's binding.
        </span>
      </div>
    </template>

    <GroupEditor
      :open="groupDialog"
      :group="editingGroup"
      :draft-rules="groupDraft?.rules"
      :draft-name="groupDraft?.name"
      :saving="groupSaving"
      :error="groupError"
      @close="closeGroup"
      @save="saveGroup"
    />
    <ZoneEditor
      :open="zoneDialog"
      :zone="editingZone"
      :saving="zoneSaving"
      :error="zoneError"
      @close="zoneDialog = false"
      @save="saveZone"
    />
    <BindingEditor
      :open="bindingDialog"
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
      :row="selectedRow"
      :baseline="rulesetBaseline"
      :ruleset="selectedReview?.ruleset ?? ''"
      :findings="selectedReview?.findings ?? []"
      :compile-error="selectedReviewError"
      :planning="planning"
      :error="planError"
      @close="applyDialog = false"
      @confirm="confirmApply"
    />

    <ModalDialog
      :open="Boolean(deleteTarget)"
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
    </ModalDialog>
  </main>
</template>
