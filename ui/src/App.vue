<script setup lang="ts">
/**
 * NetGuard: a firewall control plane for a fleet of small nodes.
 *
 * The surface is organised around one question, asked in this order: what is
 * open to the internet right now and on which node (the exposure lens), what
 * should be allowed (groups and zones), and what exactly will change if I
 * apply (the per-node review and its diff).
 *
 * The page is built on the shared plugin chassis, in the reading order every
 * plugin frame shares: header and proof line, notices, the stat strip, the
 * toolbar with the lens tabs, then one table card per lens whose rows fold
 * their detail underneath. The toolbar keeps one shape on every lens (tabs,
 * the search, the note, one primary action) so a control learned on one tab
 * is where it was on the next. The look lives in the chassis sheet; this
 * file owns the facts and the flow.
 *
 * Two constraints shape everything below. The frame the host renders this in
 * is a viewport the host sizes itself, so this document is the one scroller
 * and overlays are fixed against the window; nothing here measures the page
 * or reports a height. And every state has to be honest, because a firewall
 * panel that renders an unreported node as a healthy one is worse than no
 * panel at all.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Boxes, Plus, Radar, RefreshCw, Shield, ShieldCheck, TriangleAlert } from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "@latticenet/plugin-bridge";
import {
  PcButton,
  PcConfirmDialog,
  PcCount,
  PcEmptyState,
  PcLensTab,
  PcLensTabs,
  PcNotice,
  PcPageHeader,
  PcPagination,
  PcPanel,
  PcPanelHeader,
  PcProofLine,
  PcSearchField,
  PcSkeleton,
  PcStatCard,
  PcStatStrip,
  PcToolbar,
  PcWorkspace,
  useDocumentQueryState,
  useExpandSet,
  useOverlayEscape,
} from "@latticenet/plugin-bridge/chassis";

import ApplyDialog from "./components/ApplyDialog.vue";
import BindingEditor from "./components/BindingEditor.vue";
import ExposureFindings from "./components/ExposureFindings.vue";
import ExposureTable, { type DetailState, type ExposureRowView } from "./components/ExposureTable.vue";
import GroupEditor from "./components/GroupEditor.vue";
import GroupsTable from "./components/GroupsTable.vue";
import NodeDetail from "./components/NodeDetail.vue";
import ZoneEditor from "./components/ZoneEditor.vue";
import ZonesTable from "./components/ZonesTable.vue";
import {
  applyOrder,
  computeExposure,
  draftRuleFor,
  findingsFor,
  formatProcesses,
  matchesGroup,
  matchesZone,
  newestCollectedAt,
  settleOrder,
  usedByNodes,
  type ExposureContext,
  type ExposureSortKey,
  type Finding,
  type KnockGate,
  type OrderIndex,
} from "./exposure";
import { countPosture, joinPosture, type PostureRow } from "./posture";
import {
  deleteQuestion,
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
import { statTiles } from "./stats";
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

type Lens = "exposure" | "attention" | "groups" | "zones";
const LENSES: readonly Lens[] = ["exposure", "attention", "groups", "zones"];

const init = ref<HostInit>();
const overview = ref<Overview>({ nodes: [], groups: [], zones: [] });
const realityRows = ref<RealitySummary[]>([]);
const realityTruncated = ref(false);
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const bootError = ref("");
/** Which of the two reads the last refresh lost, so the stat strip can say so. */
const overviewFailed = ref(false);
const realityFailed = ref(false);

/* The plugin document's own query string can open a lens, a search or a node,
 * so a host, a reviewer or an agent can deep-link a state (`?lens=groups`,
 * `?q=postgres`, `?expand=<node_id>`; the older `?node=` still opens one). The
 * nonce lives in the fragment and is left alone. */
const documentQuery = useDocumentQueryState();
const requestedLens = documentQuery.read("lens")[0];
const lens = ref<Lens>(LENSES.includes(requestedLens as Lens) ? (requestedLens as Lens) : "exposure");
const search = ref(documentQuery.read("q")[0] ?? "");
/** Node ids whose detail is open in place under their row. */
const expanded = useExpandSet([...documentQuery.read("expand"), ...documentQuery.read("node")]);
/** Security group ids whose rules are unfolded. */
const groupsOpen = useExpandSet();

watch([lens, search, expanded.keys], () => {
  try {
    documentQuery.write("lens", lens.value === "exposure" ? [] : [lens.value]);
    documentQuery.write("q", search.value.trim() ? [search.value.trim()] : []);
    documentQuery.write("node", []);
    documentQuery.write("expand", [...expanded.keys.value]);
  } catch {
    // A sandbox that refuses history writes still renders; the link is a convenience.
  }
});

useOverlayEscape();

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
  let lostOverview = false;
  let lostReality = false;
  try {
    overview.value = await call<Overview>("overview");
  } catch (cause) {
    lostOverview = true;
    failures.push(safeErrorMessage(cause, "The NetGuard overview could not be loaded"));
  }
  try {
    await loadReality();
  } catch (cause) {
    lostReality = true;
    failures.push(safeErrorMessage(cause, "Reality snapshots could not be loaded"));
  }
  if (epoch !== refreshEpoch) return;
  overviewFailed.value = lostOverview;
  realityFailed.value = lostReality;
  // Partial failure is reported as partial, never rounded up to a working
  // panel: half this surface is intent and half is evidence, and a fleet
  // rendered from one of them alone is misleading. One failure per line.
  error.value = failures.map(endSentence).join("\n");
  observedAt.value = Date.now();
  loading.value = false;
  refreshing.value = false;
  // A node opened by URL needs its review the same way a clicked one does.
  if (!background) for (const nodeId of expanded.keys.value) void loadReviewFor(nodeId);
  // The order is settled twice per refresh: once on what the list alone knows
  // (drift, name), then once more when every snapshot has landed. In between
  // the rows hold still.
  settle();
  await loadDetails(epoch);
  if (epoch === refreshEpoch) settle();
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
/**
 * The settled display order. Rows are read through it rather than sorted
 * live, because the default order ranks by unexplained ports and every node
 * reports 0 of those until its own snapshot read returns: a live sort moves
 * the row under the pointer for the first seconds after load.
 */
const order = ref<OrderIndex>(new Map());

function settle(): void {
  order.value = settleOrder(views.value, sortKey.value, sortDirection.value);
}

function onSort(key: ExposureSortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDirection.value = "asc";
  }
  settle();
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
const needle = computed(() => search.value.trim().toLowerCase());
const matchedViews = computed(() => {
  const matched = needle.value ? views.value.filter((view) => matchesSearch(view, needle.value)) : views.value;
  return applyOrder(matched, order.value);
});

/* The same search field narrows every lens. On Groups a hit inside a rule
 * opens the group while the search stands, because the operator asked for
 * the rule, not the group; clearing the search restores their own set. */
const groupHits = computed(() => new Map(overview.value.groups.map((group) => [group.id, matchesGroup(group, exposureContext.value, needle.value)])));
const matchedGroups = computed(() => (needle.value ? overview.value.groups.filter((group) => groupHits.value.get(group.id)?.hit) : overview.value.groups));
const matchedZones = computed(() => (needle.value ? overview.value.zones.filter((zone) => matchesZone(zone, needle.value)) : overview.value.zones));

function groupOpen(groupId: string): boolean {
  return groupsOpen.isOpen(groupId) || (needle.value.length > 0 && groupHits.value.get(groupId)?.inRules === true);
}

const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(matchedViews.value.length / NODE_PAGE_SIZE)));
const pageStart = computed(() => (Math.min(page.value, pageCount.value) - 1) * NODE_PAGE_SIZE);
const pageViews = computed(() => matchedViews.value.slice(pageStart.value, pageStart.value + NODE_PAGE_SIZE));
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
const proofSegments = computed(() => {
  const segments: string[] = [];
  if (newestObserved.value) segments.push(`observed ${clockUtc(newestObserved.value)}, ${ageLabel(newestObserved.value, observedAt.value)} ago`);
  else if (canSeeReality.value) segments.push("not observed yet");
  else segments.push("reality not readable");
  segments.push(`${counts.value.total} ${nodesWord(counts.value.total)} report`);
  if (readingSnapshots.value) segments.push(`reading ${detailProgress.value.done} of ${detailProgress.value.total} snapshots`);
  return segments;
});

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
/** The tab count: a fact about the findings list, absent rather than "0". */
const findingsCount = computed(() => (findings.value.length ? findings.value.length : null));

function findingsForNode(nodeId: string): Finding[] {
  return findings.value.filter((finding) => finding.nodeId === nodeId);
}

function toggleFinding(key: string): void {
  if (expandedFindings.value.has(key)) {
    expandedFindings.value.delete(key);
    return;
  }
  expandedFindings.value.add(key);
  const finding = findings.value.find((candidate) => candidate.key === key);
  if (finding) void ensureReview(finding.nodeId);
}

/** From a red port in the exposure cell to its row on the Attention lens. */
async function focusFinding(key: string): Promise<void> {
  ignored.value.delete(key);
  if (!expandedFindings.value.has(key)) toggleFinding(key);
  lens.value = "attention";
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
 * The ruleset as it stood when each node's detail was opened. It is the left
 * side of the apply diff: the only "before" a client can honestly show,
 * because a reality snapshot reports the live table as a hash, never as text.
 */
const rulesetBaselines = ref(new Map<string, string>());

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

function reviewErrorFor(nodeId: string): string {
  return reviews.value.get(nodeId)?.compile_error || reviewErrors.value.get(nodeId) || "";
}

/** A fresh review for one node, and the diff baseline its detail opened with. */
async function loadReviewFor(nodeId: string): Promise<void> {
  rulesetBaselines.value.delete(nodeId);
  await ensureReview(nodeId, true);
  if (expanded.isOpen(nodeId)) rulesetBaselines.value.set(nodeId, reviews.value.get(nodeId)?.ruleset ?? "");
}

function toggleNode(nodeId: string): void {
  expanded.toggle(nodeId);
  if (expanded.isOpen(nodeId)) void loadReviewFor(nodeId);
}

async function reloadReview(nodeId: string): Promise<void> {
  if (nodeId) await ensureReview(nodeId, true);
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
    await reloadOpenReviews();
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
    await reloadOpenReviews();
  } catch (cause) {
    zoneError.value = safeErrorMessage(cause, "The zone could not be saved");
  } finally {
    zoneSaving.value = false;
  }
}

/** The node a row-scoped dialog (binding, apply, adopt) is about. */
const dialogNodeId = ref("");
const dialogRow = computed<PostureRow | undefined>(() => posture.value.find((row) => row.nodeId === dialogNodeId.value));
const dialogReview = computed(() => reviews.value.get(dialogNodeId.value));

async function reloadOpenReviews(): Promise<void> {
  await Promise.all([...expanded.keys.value].map((nodeId) => reloadReview(nodeId)));
}

const bindingDialog = ref(false);
const bindingSaving = ref(false);
const bindingError = ref("");

function openBinding(nodeId: string): void {
  dialogNodeId.value = nodeId;
  bindingError.value = "";
  bindingDialog.value = true;
}

async function saveBinding(payload: Record<string, unknown>): Promise<void> {
  bindingSaving.value = true;
  bindingError.value = "";
  try {
    await call("upsert_binding", payload);
    notice.value = `Binding for ${dialogRow.value?.nodeName ?? "node"} saved`;
    bindingDialog.value = false;
    await refresh(true);
    await reloadOpenReviews();
  } catch (cause) {
    bindingError.value = safeErrorMessage(cause, "The node binding could not be saved");
  } finally {
    bindingSaving.value = false;
  }
}

async function adopt(nodeId: string): Promise<void> {
  const row = posture.value.find((candidate) => candidate.nodeId === nodeId);
  if (!row) return;
  try {
    await call("adopt", { node_id: row.nodeId });
    notice.value = `${row.nodeName} adopted into NetGuard`;
    await refresh(true);
    await reloadOpenReviews();
  } catch (cause) {
    error.value = safeErrorMessage(cause, "The legacy baseline could not be adopted");
  }
}

// ── delete ──────────────────────────────────────────────────────────────────

const deleteTarget = ref<{ type: "group" | "zone"; id: string; label: string; usedBy: number }>();
const deleteError = ref("");
const deleting = ref(false);

function askDelete(type: "group" | "zone", id: string, label: string): void {
  deleteError.value = "";
  // The count the row showed a moment ago, carried into the question, since
  // the modal covers the row.
  const usedBy = usedByNodes(overview.value.nodes, type === "group" ? "group_ids" : "zone_ids", id);
  deleteTarget.value = { type, id, label, usedBy };
}

function cancelDelete(): void {
  if (!deleting.value) deleteTarget.value = undefined;
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
    await reloadOpenReviews();
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

function openApply(nodeId: string): void {
  dialogNodeId.value = nodeId;
  planError.value = "";
  applyDialog.value = true;
}

async function confirmApply(acceptLockoutRisk: boolean): Promise<void> {
  const row = dialogRow.value;
  if (!row) return;
  planning.value = true;
  planError.value = "";
  try {
    const result = await call<{ approval: { id: string } }>("plan", {
      node_id: row.nodeId,
      accept_lockout_risk: acceptLockoutRisk,
    });
    const approvalId = result.approval?.id ?? "";
    notice.value = `Approval created for ${row.nodeName}${approvalId ? ` (${approvalId})` : ""}. The node keeps its current rules until someone approves it.`;
    applyDialog.value = false;
    await refresh(true);
    await reloadReview(row.nodeId);
    const ruleset = reviews.value.get(row.nodeId)?.ruleset;
    if (ruleset !== undefined) rulesetBaselines.value.set(row.nodeId, ruleset);
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

/** The one recovery from a missing handshake: a fresh document asks the host again. */
function reloadPage(): void {
  window.location.reload();
}

// ── words ───────────────────────────────────────────────────────────────────

function nodesWord(count: number): string {
  return count === 1 ? "node" : "nodes";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const permissionNote = computed(() => {
  if (loading.value || bootError.value || canAdmin.value) return "";
  if (lens.value === "zones") return "read-only: netguard:admin is needed to create or edit a zone";
  return "read-only: netguard:admin is needed to create or edit a group";
});

/* One search field, one place, on every lens; only its placeholder and the
 * match note change with the lens. */
const searchPlaceholder = computed(() => {
  if (lens.value === "groups") return "Search by group, rule port, remote or comment";
  if (lens.value === "zones") return "Search by zone, interface or CIDR";
  return "Search by node, group, zone, port or process";
});
const searchLabel = computed(() => (lens.value === "groups" ? "Search groups" : lens.value === "zones" ? "Search zones" : "Search nodes"));
const matchNote = computed(() => {
  if (!searching.value || loading.value || bootError.value) return "";
  if (lens.value === "groups") return `${matchedGroups.value.length} of ${plural(overview.value.groups.length, "group", "groups")} match`;
  if (lens.value === "zones") return `${matchedZones.value.length} of ${plural(overview.value.zones.length, "zone", "zones")} match`;
  return `${matchedViews.value.length} of ${counts.value.total} ${nodesWord(counts.value.total)} match`;
});
/** The one creating verb per lens: a group on Exposure and Attention (a finding resolves into a rule), a zone on Zones. */
const primaryVerb = computed<"group" | "zone">(() => (lens.value === "zones" ? "zone" : "group"));

/* The strip says "unknown" for a tile whose read failed, never the zero an
 * empty join produces. */
const tiles = computed(() =>
  statTiles(counts.value, { overviewFailed: overviewFailed.value, realityFailed: realityFailed.value, canSeeReality: canSeeReality.value }),
);
</script>

<template>
  <PcWorkspace>
    <PcPageHeader
      title="NetGuard"
      badge="NetGuard plugin"
      description="nftables firewall control for the fleet: what you declared, and what each machine reports it actually has."
    >
      <template #icon><Shield :size="19" /></template>
      <template #actions>
        <PcButton :busy="refreshing" :disabled="loading || Boolean(bootError)" @click="refresh(true)">
          <template #icon><RefreshCw :size="15" /></template>Refresh
        </PcButton>
      </template>
      <template v-if="!loading && !bootError" #proof>
        <PcProofLine :segments="proofSegments" :refreshing="refreshing" :title="proofTitle" />
      </template>
    </PcPageHeader>

    <PcNotice v-if="error" dismissible title="Part of this page could not be loaded" @dismiss="error = ''">
      <p class="ng-pre-line">{{ error }}</p>
      <template #actions><PcButton compact :busy="refreshing" @click="refresh(true)">Try again</PcButton></template>
    </PcNotice>
    <PcNotice v-if="notice" tone="success" dismissible @dismiss="notice = ''">
      <p>{{ notice }}</p>
    </PcNotice>
    <PcNotice v-if="realityTruncated" tone="warning" title="This fleet is larger than this panel paged through">
      <p>The exposure below covers only the nodes listed. Narrow the view before trusting the totals.</p>
    </PcNotice>
    <PcNotice v-if="!canSeeReality && !loading && !bootError" tone="warning" title="This session cannot read node reality">
      <p>Exposure and drift cannot be shown. Everything below is declared intent only.</p>
    </PcNotice>

    <PcSkeleton v-if="loading" variant="strip" :count="5" label="Loading the firewall summary" />
    <PcStatStrip v-else-if="!bootError" :count="5" label="Fleet summary">
      <PcStatCard v-for="tile in tiles" :key="tile.label" :label="tile.label" :value="tile.value" :tone="tile.tone" :note="tile.note" :data-unknown="tile.unknown ? 'true' : undefined" />
    </PcStatStrip>

    <PcToolbar label="NetGuard toolbar">
      <template #tabs>
        <PcLensTabs v-model="lens" label="NetGuard lens">
          <PcLensTab value="exposure" label="Exposure">
            <template #icon><Shield :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="attention" label="Attention" :count="findingsCount" count-tone="error">
            <template #icon><TriangleAlert :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="groups" label="Groups" :count="loading || bootError ? null : overview.groups.length">
            <template #icon><Boxes :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="zones" label="Zones" :count="loading || bootError ? null : overview.zones.length">
            <template #icon><ShieldCheck :size="14" /></template>
          </PcLensTab>
        </PcLensTabs>
      </template>
      <template #search>
        <PcSearchField v-model="search" :label="searchLabel" :placeholder="searchPlaceholder" />
      </template>
      <template v-if="matchNote" #note>{{ matchNote }}</template>
      <template v-else-if="permissionNote" #note>{{ permissionNote }}</template>
      <template v-if="canAdmin && !loading" #primary>
        <PcButton v-if="primaryVerb === 'zone'" variant="primary" @click="openZone()"><template #icon><Plus :size="15" /></template>New zone</PcButton>
        <PcButton v-else variant="primary" @click="openGroup()"><template #icon><Plus :size="15" /></template>New group</PcButton>
      </template>
    </PcToolbar>

    <PcPanel v-if="bootError" label="No session">
      <PcEmptyState kind="handshake" title="The console has not answered">
        <p>{{ bootError }}</p>
        <template #actions><PcButton @click="reloadPage">Reload the page</PcButton></template>
      </PcEmptyState>
    </PcPanel>

    <PcPanel v-else-if="loading" label="Loading">
      <PcPanelHeader title="Loading firewall state" description="The declared intent and every node's last snapshot are on their way." />
      <PcSkeleton :count="8" label="Loading firewall state" />
    </PcPanel>

    <PcPanel v-else-if="lens === 'exposure'" id="pc-panel-exposure" role="tabpanel" aria-labelledby="pc-tab-exposure">
      <PcPanelHeader title="Exposure" description="What each node actually has open to the internet, against what you declared. A row folds the node's evidence and its generated ruleset underneath; a red port opens its finding on the Attention lens.">
        <PcCount :value="`${plural(counts.total, 'node', 'nodes')}${findings.length ? ` · ${plural(findings.length, 'finding', 'findings')}` : ''}`" />
      </PcPanelHeader>

      <PcEmptyState v-if="error && !posture.length" kind="error" title="Nothing could be loaded">
        <p>This is not an empty fleet, it is an unanswered question.</p>
        <p class="ng-pre-line">{{ error }}</p>
        <template #actions><PcButton :busy="refreshing" @click="refresh(true)">Try again</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else-if="!posture.length" title="No nodes are visible">
        <template #icon><Radar :size="26" /></template>
        <p>This session can see no nodes at all. A node appears here once its agent reports, or once it is bound to a security group.</p>
      </PcEmptyState>
      <PcEmptyState v-else-if="!matchedViews.length" kind="no-match" title="No node matches that search">
        <template #icon><Radar :size="26" /></template>
        <p>Nothing in {{ plural(counts.total, 'node', 'nodes') }} matches <span class="pc-mono">{{ search.trim() }}</span>. The search covers node name and id, group and zone ids, group names, open ports and their owning process.</p>
        <template #actions><PcButton @click="search = ''">Clear the search</PcButton></template>
      </PcEmptyState>

      <ExposureTable
        v-else
        :rows="pageViews"
        :sort-key="sortKey"
        :sort-direction="sortDirection"
        :is-open="expanded.isOpen"
        :ignored="ignored"
        :observed-at="observedAt"
        :can-see-reality="canSeeReality"
        @sort="onSort"
        @toggle="toggleNode"
        @finding="focusFinding"
      >
        <template #detail="{ view }">
          <NodeDetail
            :row="view.row"
            :review="reviews.get(view.row.nodeId)"
            :loading="reviewLoading.has(view.row.nodeId)"
            :review-error="reviewErrorFor(view.row.nodeId)"
            :findings="findingsForNode(view.row.nodeId)"
            :ignored="ignored"
            :zones="overview.zones"
            :can-admin="canAdmin"
            :can-plan="canPlan"
            @edit-binding="openBinding(view.row.nodeId)"
            @plan="openApply(view.row.nodeId)"
            @adopt="adopt(view.row.nodeId)"
            @add="addToGroup"
            @ignore="ignoreFinding"
            @restore="restoreFinding"
          />
        </template>
      </ExposureTable>

      <PcPagination
        v-if="pageCount > 1"
        v-model:page="page"
        :pages="pageCount"
        :from="pageStart + 1"
        :to="Math.min(pageStart + NODE_PAGE_SIZE, matchedViews.length)"
        :total="matchedViews.length"
        noun="Nodes"
        label="Exposure pagination"
      />
    </PcPanel>

    <ExposureFindings
      v-else-if="lens === 'attention'"
      id="pc-panel-attention"
      role="tabpanel"
      aria-labelledby="pc-tab-attention"
      :findings="findings"
      :expanded="expandedFindings"
      :ignored="ignored"
      :reviews="reviews"
      :review-loading="reviewLoading"
      :review-errors="reviewErrors"
      :can-admin="canAdmin"
      :can-see-reality="canSeeReality"
      :reading="detailProgress"
      :searching="searching"
      :nodes="matchedViews.length"
      @toggle="toggleFinding"
      @add="addToGroup"
      @ignore="ignoreFinding"
      @restore="restoreFinding"
    />

    <PcPanel v-else-if="lens === 'groups'" id="pc-panel-groups" role="tabpanel" aria-labelledby="pc-tab-groups">
      <PcPanelHeader title="Security groups" description="Ordered rules, attached to one or more nodes. The chain policy stays default drop, so anything no rule accepts is dropped. A group folds its rules underneath.">
        <PcCount :value="plural(overview.groups.length, 'group', 'groups')" />
      </PcPanelHeader>
      <GroupsTable
        v-if="matchedGroups.length"
        :groups="matchedGroups"
        :nodes="overview.nodes"
        :context="exposureContext"
        :is-open="groupOpen"
        :can-admin="canAdmin"
        @toggle="groupsOpen.toggle"
        @edit="openGroup"
        @delete="(group) => askDelete('group', group.id, group.name)"
      />
      <PcEmptyState v-else-if="overview.groups.length" kind="no-match" title="No group matches that search">
        <template #icon><Boxes :size="26" /></template>
        <p>Nothing in {{ plural(overview.groups.length, 'group', 'groups') }} matches <span class="pc-mono">{{ search.trim() }}</span>. The search covers group name, id and description, and each rule's sentence and comment.</p>
        <template #actions><PcButton @click="search = ''">Clear the search</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else title="No security groups">
        <template #icon><Boxes :size="26" /></template>
        <p>A group is a reusable, ordered rule set. Create one, then attach it to a managed node in that node's binding.</p>
        <template v-if="canAdmin" #actions>
          <PcButton variant="primary" @click="openGroup()"><template #icon><Plus :size="15" /></template>New group</PcButton>
        </template>
      </PcEmptyState>
    </PcPanel>

    <PcPanel v-else id="pc-panel-zones" role="tabpanel" aria-labelledby="pc-tab-zones">
      <PcPanelHeader title="Trusted zones" description="Interfaces and CIDRs accepted before any security group is evaluated. A built-in zone is resolved on every node.">
        <PcCount :value="plural(overview.zones.length, 'zone', 'zones')" />
      </PcPanelHeader>
      <ZonesTable
        v-if="matchedZones.length"
        :zones="matchedZones"
        :nodes="overview.nodes"
        :can-admin="canAdmin"
        @edit="openZone"
        @delete="(zone) => askDelete('zone', zone.id, zone.name)"
      />
      <PcEmptyState v-else-if="overview.zones.length" kind="no-match" title="No zone matches that search">
        <template #icon><ShieldCheck :size="26" /></template>
        <p>Nothing in {{ plural(overview.zones.length, 'zone', 'zones') }} matches <span class="pc-mono">{{ search.trim() }}</span>. The search covers zone name, id and description, interfaces and CIDRs.</p>
        <template #actions><PcButton @click="search = ''">Clear the search</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else title="No trusted zones">
        <template #icon><ShieldCheck :size="26" /></template>
        <p>A zone names the interfaces and CIDRs a node accepts before any security group runs. Create one to keep a management path open, then attach it in a node's binding.</p>
        <template v-if="canAdmin" #actions>
          <PcButton variant="primary" @click="openZone()"><template #icon><Plus :size="15" /></template>New zone</PcButton>
        </template>
      </PcEmptyState>
    </PcPanel>

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
      :node="dialogRow?.intent"
      :groups="overview.groups"
      :zones="overview.zones"
      :saving="bindingSaving"
      :error="bindingError"
      @close="bindingDialog = false"
      @save="saveBinding"
    />
    <ApplyDialog
      :open="applyDialog"
      :row="dialogRow"
      :baseline="rulesetBaselines.get(dialogNodeId) ?? ''"
      :ruleset="dialogReview?.ruleset ?? ''"
      :findings="dialogReview?.findings ?? []"
      :compile-error="reviewErrorFor(dialogNodeId)"
      :planning="planning"
      :error="planError"
      @close="applyDialog = false"
      @confirm="confirmApply"
    />

    <PcConfirmDialog
      :open="Boolean(deleteTarget)"
      :title="`Delete ${deleteTarget?.label ?? ''}?`"
      confirm-label="Delete"
      destructive
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    >
      <div class="ng-stack">
        <p>{{ deleteTarget ? deleteQuestion(deleteTarget.type, deleteTarget.label, deleteTarget.usedBy) : '' }}</p>
        <PcNotice v-if="deleteError"><p>{{ deleteError }}</p></PcNotice>
      </div>
    </PcConfirmDialog>
  </PcWorkspace>
</template>
