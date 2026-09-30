<script setup lang="ts">
/**
 * NetGuard: a firewall control plane for a fleet of small nodes.
 *
 * The page is layered the way every console area is (design 22 section 2):
 * Overview first, with what needs a hand, four numbers and one picture of
 * what the fleet has open to the internet; then Nodes, the exposure table;
 * then Groups and Zones, the declared rules. One tab row switches layers. A
 * node opens in a side panel with its evidence, its generated ruleset and its
 * actions, from any layer, and the layer, the open node, the search and the
 * Nodes filter live in the console's address, so a reload or a pasted link
 * lands on the same place.
 *
 * Two constraints shape everything below. The frame the host renders this in
 * is a viewport the host sizes itself, so this document is the one scroller
 * and overlays are fixed against the window; nothing here measures the page
 * or reports a height. And every state has to be honest, because a firewall
 * panel that renders an unreported node as a healthy one is worse than no
 * panel at all.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Boxes, LayoutDashboard, Plus, Radar, RefreshCw, Server, Shield, ShieldCheck } from "@lucide/vue";

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
  PcSidePanel,
  PcSkeleton,
  PcStatCard,
  PcStatStrip,
  PcToolbar,
  PcWorkspace,
  useOverlayEscape,
} from "@latticenet/plugin-bridge/chassis";

import { adoptPreview } from "./adopt";
import AdoptDialog from "./components/AdoptDialog.vue";
import ApplyDialog from "./components/ApplyDialog.vue";
import AttentionList from "./components/AttentionList.vue";
import BindingEditor from "./components/BindingEditor.vue";
import ExposureTable from "./components/ExposureTable.vue";
import GroupEditor from "./components/GroupEditor.vue";
import GroupsTable from "./components/GroupsTable.vue";
import NodeDetail from "./components/NodeDetail.vue";
import PortPicture from "./components/PortPicture.vue";
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
import {
  attentionItems,
  needsAttention,
  overviewNumbers,
  portPicture,
  type AttentionItem,
  type DetailState,
  type ExposureRowView,
} from "./overview";
import {
  channelFromHash,
  createStateSender,
  documentPageState,
  listenForInitPageState,
  stateMessage,
  validPageState,
  writeDocumentState,
  type PageState,
  type StateSender,
} from "./pageState";
import { coverageLabel, countPosture, joinPosture, type PostureRow } from "./posture";
import type { MenuItem } from "./rowMenu";
import { ageLabel, clockUtc, stampUtc } from "./time";
import { PANEL_TITLE, decodeNgState, encodeNgState, nodePanelState, type NgPageState, type NgView, type NodeFilter } from "./viewState";

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

const init = ref<HostInit>();
const overview = ref<Overview>({ nodes: [], groups: [], zones: [] });
const realityRows = ref<RealitySummary[]>([]);
const realityTruncated = ref(false);
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const bootError = ref("");
/** Which of the two reads the last refresh lost, so the numbers can say so. */
const overviewFailed = ref(false);
const realityFailed = ref(false);

// ── page state: layer, open node, search, Nodes filter ──────────────────────
//
// The console's address carries them (pageState.ts). Before the host says
// where the operator was, the page starts from its own document query: empty
// under any real console, set only by a host that keeps no page state, or by
// an old `?lens=` link to the frame itself.
const startState = decodeNgState(documentPageState());
const view = ref<NgView>(startState.view);
const search = ref(startState.q);
const nodeFilter = ref<NodeFilter>(startState.show);
/** The node whose side panel is open, or asked for by a link and not yet loaded. */
const openId = ref(startState.open);

function applyState(state: NgPageState): void {
  view.value = state.view;
  search.value = state.q;
  nodeFilter.value = state.show;
  openId.value = state.open;
}

const pageState = computed<PageState>(() =>
  encodeNgState({ view: view.value, open: openId.value, q: search.value, show: nodeFilter.value }),
);

const channel = channelFromHash(window.location.hash);
/** The state the host's init carried: undefined from a host that keeps none. */
let hostState: PageState | undefined;
let hostKeepsState = false;
let stateSender: StateSender | undefined;
/* Registered before the bridge client, so it hears init first (pageState.ts). */
let stopInitListener: (() => void) | undefined = channel
  ? listenForInitPageState(window, channel, (state) => {
      hostState = state;
    })
  : undefined;

/* The state goes out only after init, and only once the operator changes
 * something: the page's reading of the address (defaults filled in, unknown
 * values dropped) is not a reason to rewrite a pasted link. */
function adoptPageState(): void {
  hostKeepsState = hostState !== undefined;
  if (hostState) applyState(decodeNgState(hostState));
  stopInitListener?.();
  stopInitListener = undefined;
  stateSender?.dispose();
  stateSender = createStateSender(sendState, { baseline: pageState.value });
}

function sendState(state: PageState): void {
  const valid = validPageState(state);
  if (!bridge || !channel || !valid) return;
  window.parent.postMessage(stateMessage(bridge.nonce, valid), channel.hostOrigin);
}

function publishPageState(state: PageState): void {
  if (!stateSender) return;
  // A host that keeps no page state ignores the message; the frame's own
  // query is then the only place the state can survive a frame reload.
  if (!hostKeepsState) writeDocumentState(state);
  stateSender.push(state);
}
watch(pageState, publishPageState);

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
      adoptPageState();
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
  stopInitListener?.();
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
  // A node opened by the address needs its review the same way a clicked one does.
  if (!background && openId.value) void loadReviewFor(openId.value);
  // The order is settled twice per refresh: once on what the list alone knows
  // (drift, name), then once more when every snapshot has landed. In between
  // the rows hold still.
  settle();
  await loadDetails(epoch);
  if (epoch === refreshEpoch) settle();
}

// ── the join every layer reads ──────────────────────────────────────────────

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

const readingSnapshots = computed(
  () => detailProgress.value.total > 0 && detailProgress.value.done < detailProgress.value.total,
);

// ── Overview ────────────────────────────────────────────────────────────────

const attention = computed(() =>
  attentionItems(views.value, { canSeeReality: canSeeReality.value, realityFailed: realityFailed.value }),
);
const numbers = computed(() =>
  overviewNumbers(counts.value, views.value, {
    overviewFailed: overviewFailed.value,
    realityFailed: realityFailed.value,
    canSeeReality: canSeeReality.value,
    reading: detailProgress.value,
  }),
);
const picture = computed(() => portPicture(views.value));

function onAttention(item: AttentionItem): void {
  if (item.action.kind === "open") {
    openNode(item.action.nodeId);
    return;
  }
  search.value = "";
  nodeFilter.value = "attention";
  view.value = "nodes";
}

function showPort(port: string): void {
  search.value = port;
  nodeFilter.value = "all";
  view.value = "nodes";
}

function showNodes(): void {
  view.value = "nodes";
}

// ── Nodes ───────────────────────────────────────────────────────────────────

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
function matchesSearch(candidate: ExposureRowView, needle: string): boolean {
  const haystack = [
    candidate.row.nodeId,
    candidate.row.nodeName,
    ...candidate.row.groupIds,
    ...candidate.row.zoneIds,
    ...(candidate.exposure.managedBy.kind === "none" ? [] : candidate.exposure.managedBy.names),
    ...candidate.exposure.open.map((span) => `${span.from} ${span.to} ${formatProcesses(span)}`),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

const searching = computed(() => search.value.trim().length > 0);
const needle = computed(() => search.value.trim().toLowerCase());
const attentionCount = computed(() => views.value.filter(needsAttention).length);
const filteredViews = computed(() => (nodeFilter.value === "attention" ? views.value.filter(needsAttention) : views.value));
const matchedViews = computed(() => {
  const matched = needle.value ? filteredViews.value.filter((candidate) => matchesSearch(candidate, needle.value)) : filteredViews.value;
  return applyOrder(matched, order.value);
});

/* The same search field narrows every collection layer. On Groups a hit
 * inside a rule opens the group while the search stands, because the
 * operator asked for the rule, not the group; clearing the search restores
 * their own set. */
const groupHits = computed(() => new Map(overview.value.groups.map((group) => [group.id, matchesGroup(group, exposureContext.value, needle.value)])));
const matchedGroups = computed(() => (needle.value ? overview.value.groups.filter((group) => groupHits.value.get(group.id)?.hit) : overview.value.groups));
const matchedZones = computed(() => (needle.value ? overview.value.zones.filter((zone) => matchesZone(zone, needle.value)) : overview.value.zones));
const groupsOpen = ref(new Set<string>());

function toggleGroup(groupId: string): void {
  const next = new Set(groupsOpen.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  groupsOpen.value = next;
}

function groupOpen(groupId: string): boolean {
  return groupsOpen.value.has(groupId) || (needle.value.length > 0 && groupHits.value.get(groupId)?.inRules === true);
}

const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(matchedViews.value.length / NODE_PAGE_SIZE)));
const pageStart = computed(() => (Math.min(page.value, pageCount.value) - 1) * NODE_PAGE_SIZE);
const pageViews = computed(() => matchedViews.value.slice(pageStart.value, pageStart.value + NODE_PAGE_SIZE));
watch([search, nodeFilter], () => {
  page.value = 1;
});

function nodeMenu(row: PostureRow): MenuItem[] {
  const items: MenuItem[] = [];
  if (canPlan.value) {
    const reason =
      row.coverage === "legacy"
        ? "Legacy baseline: adopt it first"
        : row.coverage === "observe_only"
          ? "Observe only: turn on management in the binding first"
          : row.coverage === "unbound"
            ? "No binding: NetGuard governs nothing on this node"
            : "";
    items.push({ key: "apply", label: "Review and apply", disabled: row.coverage !== "managed", reason });
  }
  if (canAdmin.value && row.coverage === "legacy") items.push({ key: "adopt", label: "Adopt baseline…" });
  if (canAdmin.value && row.coverage !== "legacy" && row.intent) items.push({ key: "binding", label: "Edit binding" });
  return items;
}

function onNodeAction(key: string, nodeId: string): void {
  if (key === "apply") void openApplyFromMenu(nodeId);
  else if (key === "adopt") openAdopt(nodeId);
  else if (key === "binding") openBinding(nodeId);
}

// ── the node panel ──────────────────────────────────────────────────────────

const openView = computed(() => views.value.find((candidate) => candidate.row.nodeId === openId.value));
/**
 * A node is listed by the overview or the reality roster, so the panel may
 * say a node is not in the fleet only when both reads landed. After a failed
 * read it says the node was not read, and offers the retry.
 */
const panelState = computed(() =>
  nodePanelState({ found: Boolean(openView.value), loading: loading.value, readFailed: overviewFailed.value || realityFailed.value }),
);
const panelTitle = computed(() => (openView.value ? openView.value.row.nodeName : PANEL_TITLE[panelState.value]));
const panelDescription = computed(() => {
  const row = openView.value?.row;
  if (!row) return openId.value;
  const parts = [row.nodeId, coverageLabel(row.coverage)];
  if (row.collectedAt) parts.push(`snapshot ${stampUtc(row.collectedAt)}`);
  return parts.join(" · ");
});
/** An outcome from an action taken inside the panel, shown there rather than behind it. */
const panelNotice = ref("");

function openNode(nodeId: string): void {
  panelNotice.value = "";
  openId.value = nodeId;
}

/**
 * Close the panel. Focus goes back to whatever opened it; a panel the address
 * opened (a reload, a pasted link) had no opener, so focus lands on that
 * node's row instead of falling to the page.
 */
async function closeNode(): Promise<void> {
  const closed = openId.value;
  openId.value = "";
  panelNotice.value = "";
  await nextTick();
  const active = document.activeElement;
  if (closed && (!active || active === document.body)) {
    document.querySelector<HTMLElement>(`[id="node-${closed}"] .ng-row-open`)?.focus();
  }
}

watch(openId, (nodeId) => {
  // The first load reads the review itself; this covers every later open.
  if (nodeId && init.value && !loading.value) void loadReviewFor(nodeId);
});

/** The panel's retry: the fleet read again, then the node's review, which a background refresh leaves alone. */
async function retryPanel(): Promise<void> {
  await refresh(true);
  if (openView.value) void loadReviewFor(openView.value.row.nodeId);
}

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Session-local dismissals. Deliberately not persisted, reversible from the
 * row, and never subtracted from any count: an ignored finding is still an
 * open port, so the numbers and the attention list keep counting it.
 */
const ignored = ref(new Set<string>());

const allFindings = computed<Finding[]>(() =>
  views.value
    .filter((candidate) => candidate.detail === "loaded" && candidate.exposure.evidence === "fresh")
    .flatMap((candidate) => findingsFor(candidate.row, candidate.exposure, exposureContext.value)),
);

function findingsForNode(nodeId: string): Finding[] {
  return allFindings.value.filter((finding) => finding.nodeId === nodeId);
}

function ignoreFinding(key: string): void {
  ignored.value = new Set([...ignored.value, key]);
}

function restoreFinding(key: string): void {
  const next = new Set(ignored.value);
  next.delete(key);
  ignored.value = next;
}

function addToGroup(finding: Finding): void {
  const candidate = views.value.find((item) => item.row.nodeId === finding.nodeId);
  const managed = candidate?.exposure.managedBy;
  let target: SecurityGroup | undefined;
  if (managed?.kind === "groups") {
    const firstBound = candidate?.row.intent?.binding?.group_ids?.[0];
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
 * The ruleset as it stood when each node's panel was opened. It is the left
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

/** A fresh review for one node, and the diff baseline its panel opened with. */
async function loadReviewFor(nodeId: string): Promise<void> {
  rulesetBaselines.value.delete(nodeId);
  await ensureReview(nodeId, true);
  if (openId.value === nodeId) rulesetBaselines.value.set(nodeId, reviews.value.get(nodeId)?.ruleset ?? "");
}

async function reloadReview(nodeId: string): Promise<void> {
  if (nodeId) await ensureReview(nodeId, true);
}

async function reloadOpenReviews(): Promise<void> {
  if (openId.value) await reloadReview(openId.value);
}

/** Tell the operator where they will look: inside the panel when it is open on that node, else at the page top. */
function report(message: string, nodeId = ""): void {
  if (nodeId && openId.value === nodeId) panelNotice.value = message;
  else notice.value = message;
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
    report(`Security group ${String(payload.name)} saved`, openId.value);
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
  const nodeId = dialogNodeId.value;
  try {
    await call("upsert_binding", payload);
    report(`Binding for ${dialogRow.value?.nodeName ?? "node"} saved`, nodeId);
    bindingDialog.value = false;
    await refresh(true);
    await reloadOpenReviews();
  } catch (cause) {
    bindingError.value = safeErrorMessage(cause, "The node binding could not be saved");
  } finally {
    bindingSaving.value = false;
  }
}

// ── adopt: a question with a preview, never one click ───────────────────────

const adoptNodeId = ref("");
const adopting = ref(false);
const adoptError = ref("");
const adoptView = computed(() => views.value.find((candidate) => candidate.row.nodeId === adoptNodeId.value));
const adoptDetails = computed(() =>
  adoptView.value
    ? adoptPreview(adoptView.value, exposureContext.value, {
        reality: realityByNode.value.get(adoptNodeId.value),
        knock: knockByNode.value.get(adoptNodeId.value),
      })
    : undefined,
);

function openAdopt(nodeId: string): void {
  adoptError.value = "";
  adoptNodeId.value = nodeId;
}

function closeAdopt(): void {
  if (!adopting.value) adoptNodeId.value = "";
}

async function confirmAdopt(): Promise<void> {
  const row = adoptView.value?.row;
  if (!row) return;
  adopting.value = true;
  adoptError.value = "";
  try {
    await call("adopt", { node_id: row.nodeId });
    adoptNodeId.value = "";
    report(`${row.nodeName} is managed by NetGuard now. Its firewall is unchanged until you review and apply.`, row.nodeId);
    await refresh(true);
    await reloadOpenReviews();
  } catch (cause) {
    adoptError.value = safeErrorMessage(cause, "The legacy baseline could not be adopted. Nothing has changed.");
  } finally {
    adopting.value = false;
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

/**
 * From a row menu the panel is not open, so no baseline was taken when it
 * opened. The review is read now and its ruleset is the "before": the diff
 * then shows no change to intent, which is the truth for a re-apply.
 */
async function openApplyFromMenu(nodeId: string): Promise<void> {
  if (!reviews.value.has(nodeId) || !rulesetBaselines.value.has(nodeId)) {
    await ensureReview(nodeId, true);
    if (!rulesetBaselines.value.has(nodeId)) rulesetBaselines.value.set(nodeId, reviews.value.get(nodeId)?.ruleset ?? "");
  }
  openApply(nodeId);
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
    report(`Approval created for ${row.nodeName}${approvalId ? ` (${approvalId})` : ""}. The node keeps its current rules until someone approves it.`, row.nodeId);
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
  stopInitListener?.();
  stateSender?.dispose();
  bridge?.dispose();
});

/** The one recovery from a missing handshake: a fresh document asks the host again. */
function reloadPage(): void {
  window.location.reload();
}

// ── words ───────────────────────────────────────────────────────────────────

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const newestObserved = computed(() => newestCollectedAt(posture.value));
const proofTitle = computed(() => {
  if (!observedAt.value) return "";
  const fetched = `This page fetched at ${clockUtc(observedAt.value)}; every age is measured from then.`;
  return newestObserved.value
    ? `Newest node snapshot ${stampUtc(newestObserved.value)}. ${fetched} Refresh to observe again.`
    : `No node has reported a snapshot. ${fetched}`;
});
/**
 * The proof line says what the page knows and nothing it does not: when the
 * newest snapshot was taken, how many nodes report, how many of those are
 * stale or never reported. A read that failed prints no count at all.
 */
const proofSegments = computed(() => {
  if (realityFailed.value && overviewFailed.value) return ["not read: neither the overview nor node reality answered"];
  if (realityFailed.value) return ["node reality not read", "intent only, see the notice below"];
  const segments: string[] = [];
  if (newestObserved.value) segments.push(`observed ${clockUtc(newestObserved.value)}, ${ageLabel(newestObserved.value, observedAt.value)} ago`);
  else if (canSeeReality.value) segments.push("not observed yet");
  else segments.push("reality not readable");
  segments.push(`${plural(counts.value.total, "node", "nodes")} report`);
  if (counts.value.stale) segments.push(`${counts.value.stale} stale`);
  if (counts.value.neverReported) segments.push(`${counts.value.neverReported} never reported`);
  if (readingSnapshots.value) segments.push(`reading ${detailProgress.value.done} of ${detailProgress.value.total} snapshots`);
  return segments;
});

const permissionNote = computed(() => {
  if (loading.value || bootError.value || canAdmin.value) return "";
  if (view.value === "zones") return "read-only: netguard:admin is needed to create or edit a zone";
  return "read-only: netguard:admin is needed to create or edit a group";
});

const searchPlaceholder = computed(() => {
  if (view.value === "groups") return "Search by group, rule port, remote or comment";
  if (view.value === "zones") return "Search by zone, interface or CIDR";
  return "Search by node, group, zone, port or process";
});
const searchLabel = computed(() => (view.value === "groups" ? "Search groups" : view.value === "zones" ? "Search zones" : "Search nodes"));
const matchNote = computed(() => {
  if (!searching.value || loading.value || bootError.value) return "";
  if (view.value === "groups") return `${matchedGroups.value.length} of ${plural(overview.value.groups.length, "group", "groups")} match`;
  if (view.value === "zones") return `${matchedZones.value.length} of ${plural(overview.value.zones.length, "zone", "zones")} match`;
  return `${matchedViews.value.length} of ${plural(filteredViews.value.length, "node", "nodes")} match`;
});
/** The one creating verb per layer: a zone on Zones, a group everywhere else (a finding resolves into a rule). */
const primaryVerb = computed<"group" | "zone">(() => (view.value === "zones" ? "zone" : "group"));
/** A tab's count, or none: a count whose read failed would state a zero nobody read. */
function tabCount(value: number, failed: boolean): number | null {
  return loading.value || bootError.value || failed ? null : value;
}
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

    <PcToolbar label="NetGuard toolbar" :data-view="view">
      <template #tabs>
        <PcLensTabs v-model="view" label="NetGuard layers">
          <PcLensTab value="overview" label="Overview">
            <template #icon><LayoutDashboard :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="nodes" label="Nodes" :count="tabCount(counts.total, realityFailed)">
            <template #icon><Server :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="groups" label="Groups" :count="tabCount(overview.groups.length, overviewFailed)">
            <template #icon><Boxes :size="14" /></template>
          </PcLensTab>
          <PcLensTab value="zones" label="Zones" :count="tabCount(overview.zones.length, overviewFailed)">
            <template #icon><ShieldCheck :size="14" /></template>
          </PcLensTab>
        </PcLensTabs>
      </template>
      <!-- The search narrows the collection layers; Overview is not a list and has none. -->
      <template v-if="view !== 'overview'" #search>
        <PcSearchField v-model="search" :label="searchLabel" :placeholder="searchPlaceholder" />
      </template>
      <template v-if="view === 'nodes' && !loading && !bootError" #note>
        <select v-model="nodeFilter" class="pc-select ng-filter" aria-label="Which nodes to show">
          <option value="all">All nodes</option>
          <option value="attention">Needs attention ({{ attentionCount }})</option>
        </select>
        <span v-if="matchNote">{{ matchNote }}</span>
      </template>
      <template v-else-if="matchNote || permissionNote" #note>{{ matchNote || permissionNote }}</template>
      <!-- Overview points at the work; the creating verb lives on the layer it creates in. -->
      <template v-if="canAdmin && !loading && view !== 'overview'" #primary>
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

    <template v-else-if="loading">
      <PcSkeleton variant="strip" :count="4" label="Loading the firewall summary" />
      <PcPanel label="Loading">
        <PcPanelHeader title="Loading firewall state" description="The declared intent and every node's last snapshot are on their way." />
        <PcSkeleton :count="8" label="Loading firewall state" />
      </PcPanel>
    </template>

    <PcPanel v-else-if="error && !posture.length" label="Nothing loaded">
      <PcEmptyState kind="error" title="Nothing could be loaded">
        <p>This is not an empty fleet, it is an unanswered question.</p>
        <p class="ng-pre-line">{{ error }}</p>
        <template #actions><PcButton :busy="refreshing" @click="refresh(true)">Try again</PcButton></template>
      </PcEmptyState>
    </PcPanel>

    <!-- L0: what needs a hand, four numbers, one picture. -->
    <section v-else-if="view === 'overview'" id="pc-panel-overview" class="ng-overview" role="tabpanel" aria-labelledby="pc-tab-overview">
      <PcPanel v-if="!posture.length" label="No nodes">
        <PcEmptyState title="No nodes are visible">
          <template #icon><Radar :size="26" /></template>
          <p>This session can see no nodes at all. A node appears here once its agent reports, or once it is bound to a security group.</p>
        </PcEmptyState>
      </PcPanel>
      <template v-else>
        <AttentionList :items="attention" @act="onAttention" />
        <PcStatStrip :count="4" label="NetGuard numbers" class="ng-numbers">
          <PcStatCard v-for="number in numbers" :key="number.key" :label="number.label" :value="number.value" :tone="number.tone" :note="number.note" :data-unknown="number.unknown ? 'true' : undefined" />
        </PcStatStrip>
        <PortPicture v-if="canSeeReality && !realityFailed" :picture="picture" :reading="detailProgress" @port="showPort" @nodes="showNodes" />
      </template>
    </section>

    <PcPanel v-else-if="view === 'nodes'" id="pc-panel-nodes" role="tabpanel" aria-labelledby="pc-tab-nodes">
      <PcPanelHeader title="Nodes" description="What each node has open to the internet, against what you declared. Open a row for its evidence, its generated ruleset and its actions.">
        <PcCount v-if="realityFailed" value="intent only: reality not read" />
        <PcCount v-else :value="`${plural(counts.total, 'node', 'nodes')}${attentionCount ? ` · ${attentionCount} need attention` : ''}`" />
      </PcPanelHeader>

      <PcEmptyState v-if="!posture.length" title="No nodes are visible">
        <template #icon><Radar :size="26" /></template>
        <p>This session can see no nodes at all. A node appears here once its agent reports, or once it is bound to a security group.</p>
      </PcEmptyState>
      <PcEmptyState v-else-if="!filteredViews.length" title="No node needs attention">
        <template #icon><ShieldCheck :size="26" /></template>
        <p>No node has a port open with no rule, a drifted table or a failed apply{{ readingSnapshots ? ', on the snapshots read so far' : '' }}.</p>
        <template #actions><PcButton @click="nodeFilter = 'all'">Show all nodes</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else-if="!matchedViews.length" kind="no-match" title="No node matches that search">
        <template #icon><Radar :size="26" /></template>
        <p>Nothing in {{ plural(filteredViews.length, 'node', 'nodes') }} matches <span class="pc-mono">{{ search.trim() }}</span>. The search covers node name and id, group and zone ids, group names, open ports and their owning process.</p>
        <template #actions><PcButton @click="search = ''">Clear the search</PcButton></template>
      </PcEmptyState>

      <ExposureTable
        v-else
        :rows="pageViews"
        :sort-key="sortKey"
        :sort-direction="sortDirection"
        :active-id="openId"
        :menu-for="nodeMenu"
        :ignored="ignored"
        :observed-at="observedAt"
        :can-see-reality="canSeeReality"
        @sort="onSort"
        @open="openNode"
        @action="onNodeAction"
      />

      <PcPagination
        v-if="pageCount > 1"
        v-model:page="page"
        :pages="pageCount"
        :from="pageStart + 1"
        :to="Math.min(pageStart + NODE_PAGE_SIZE, matchedViews.length)"
        :total="matchedViews.length"
        noun="Nodes"
        label="Nodes pagination"
      />
    </PcPanel>

    <PcPanel v-else-if="view === 'groups'" id="pc-panel-groups" role="tabpanel" aria-labelledby="pc-tab-groups">
      <PcPanelHeader title="Security groups" description="Ordered rules, attached to one or more nodes. The chain policy stays default drop, so anything no rule accepts is dropped. A group folds its rules underneath.">
        <PcCount v-if="!overviewFailed" :value="plural(overview.groups.length, 'group', 'groups')" />
      </PcPanelHeader>
      <PcEmptyState v-if="overviewFailed" kind="error" title="Groups were not read">
        <p>The overview request failed, so nothing here is known. The notice above says why.</p>
        <template #actions><PcButton :busy="refreshing" @click="refresh(true)">Try again</PcButton></template>
      </PcEmptyState>
      <GroupsTable
        v-else-if="matchedGroups.length"
        :groups="matchedGroups"
        :nodes="overview.nodes"
        :context="exposureContext"
        :is-open="groupOpen"
        :can-admin="canAdmin"
        @toggle="toggleGroup"
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
        <PcCount v-if="!overviewFailed" :value="plural(overview.zones.length, 'zone', 'zones')" />
      </PcPanelHeader>
      <PcEmptyState v-if="overviewFailed" kind="error" title="Zones were not read">
        <p>The overview request failed, so nothing here is known. The notice above says why.</p>
        <template #actions><PcButton :busy="refreshing" @click="refresh(true)">Try again</PcButton></template>
      </PcEmptyState>
      <ZonesTable
        v-else-if="matchedZones.length"
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

    <!-- L2: one node, on `open=<node_id>`, from any layer. -->
    <PcSidePanel
      :open="Boolean(openId) && !bootError"
      :title="panelTitle"
      :description="panelDescription"
      class="ng-node-panel"
      close-label="Close node panel"
      @close="closeNode"
    >
      <PcSkeleton v-if="panelState === 'loading'" :count="6" label="Loading this node" />
      <PcEmptyState v-else-if="panelState === 'unread'" kind="error" title="This node could not be read">
        <p>The fleet read failed, so whether <span class="pc-mono">{{ openId }}</span> is in the fleet is not known. The message on the page says what stopped it.</p>
        <template #actions><PcButton :busy="refreshing" @click="retryPanel">Try again</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else-if="panelState === 'missing' || !openView" title="This node is not in the fleet this session can see">
        <p>The link names <span class="pc-mono">{{ openId }}</span>, which neither the overview nor the reality roster lists. It may have been deleted, renamed, or be outside this session's scope.</p>
        <template #actions><PcButton @click="closeNode(); showNodes()">Show all nodes</PcButton></template>
      </PcEmptyState>
      <template v-else>
        <PcNotice v-if="panelNotice" tone="success" dismissible class="ng-panel-notice" @dismiss="panelNotice = ''"><p>{{ panelNotice }}</p></PcNotice>
        <NodeDetail
          :row="openView.row"
          :review="reviews.get(openView.row.nodeId)"
          :loading="reviewLoading.has(openView.row.nodeId)"
          :review-error="reviewErrorFor(openView.row.nodeId)"
          :findings="findingsForNode(openView.row.nodeId)"
          :ignored="ignored"
          :zones="overview.zones"
          :can-admin="canAdmin"
          :can-plan="canPlan"
          @edit-binding="openBinding(openView.row.nodeId)"
          @plan="openApply(openView.row.nodeId)"
          @adopt="openAdopt(openView.row.nodeId)"
          @add="addToGroup"
          @ignore="ignoreFinding"
          @restore="restoreFinding"
        />
      </template>
    </PcSidePanel>

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
    <AdoptDialog
      :open="Boolean(adoptNodeId)"
      :node-name="adoptView?.row.nodeName ?? adoptNodeId"
      :preview="adoptDetails"
      :busy="adopting"
      :error="adoptError"
      @close="closeAdopt"
      @confirm="confirmAdopt"
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
