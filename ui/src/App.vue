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
import { computed, onBeforeUnmount, reactive, ref, toRef, watch } from "vue";
import { Boxes, Plus, Radar, RefreshCw, Shield, ShieldCheck } from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "@latticenet/plugin-bridge";
import { withoutSorts } from "@latticenet/plugin-bridge/query";
import {
  PcButton,
  PcConfirmDialog,
  PcEmptyState,
  PcLensTab,
  PcLensTabs,
  PcNotice,
  PcPageHeader,
  PcPagination,
  PcPanel,
  PcProofLine,
  PcQueryBar,
  PcSidePanel,
  PcSkeleton,
  PcStatCard,
  PcStatStrip,
  PcToolbar,
  PcWorkspace,
  useListQuery,
  useOverlayEscape,
} from "@latticenet/plugin-bridge/chassis";

import { adoptPreview } from "./adopt";
import AdoptDialog from "./components/AdoptDialog.vue";
import ApplyDialog from "./components/ApplyDialog.vue";
import AttentionList from "./components/AttentionList.vue";
import BindingEditor from "./components/BindingEditor.vue";
import ExposureTable from "./components/ExposureTable.vue";
import FilterSwitch from "./components/FilterSwitch.vue";
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
  GROUPS_QUERY_EXAMPLES,
  NODES_QUERY_EXAMPLES,
  ZONES_QUERY_EXAMPLES,
  groupsQuerySchema,
  groupsReachedByQuery,
  nodesQuerySchema,
  zonesQuerySchema,
} from "./listQueries";
import { attentionComparator } from "./nodeStatus";
import {
  attentionEmptyCopy,
  attentionItems,
  needsAttention,
  overviewNumbers,
  parsePortQuery,
  portPicture,
  type AttentionItem,
  type DetailState,
  type ExposureRowView,
} from "./overview";
import {
  createStateSender,
  documentPageState,
  writeDocumentState,
  type PageState,
  type StateSender,
} from "./pageState";
import { coverageLabel, countPosture, joinPosture, type PostureRow } from "./posture";
import type { MenuItem } from "./rowMenu";
import { useNow } from "./clock";
import { ageLabel, clockUtc, stampUtc } from "./time";
import {
  PANEL_TITLE,
  createVerb,
  decodeNgState,
  encodeNgState,
  nodeFilterOptions,
  nodePanelState,
  showLayerToolbar,
  type NgPageState,
  type NgView,
  type NodeFilter,
} from "./viewState";

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
/**
 * Each list layer keeps its own query for the visit. The three lists have
 * their own fields (listQueries.ts), so a Nodes query such as `status:drifted`
 * carried onto Groups would only be an error there; switching layers shows
 * that layer's query, and switching back finds the Nodes query where it was.
 * The address carries the query of the layer on screen, as `q`.
 */
type ListView = Exclude<NgView, "overview">;
const layerQuery = reactive<Record<ListView, string>>({ nodes: "", groups: "", zones: "" });
if (startState.view !== "overview") layerQuery[startState.view] = startState.q;
/** The query of the layer on screen; Overview has none. */
const search = computed<string>({
  get: () => (view.value === "overview" ? "" : layerQuery[view.value]),
  set: (value) => {
    if (view.value !== "overview") layerQuery[view.value] = value;
  },
});
const nodeFilter = ref<NodeFilter>(startState.show);
/** The node whose side panel is open, or asked for by a link and not yet loaded. */
const openId = ref(startState.open);
/** The groups the operator unfolded on the Groups layer; a search hit inside a rule opens its group without joining this set. */
const groupsOpen = ref(new Set<string>(startState.groups));

function applyState(state: NgPageState): void {
  view.value = state.view;
  layerQuery.nodes = "";
  layerQuery.groups = "";
  layerQuery.zones = "";
  if (state.view !== "overview") layerQuery[state.view] = state.q;
  nodeFilter.value = state.show;
  openId.value = state.open;
  groupsOpen.value = new Set(state.groups);
}

const pageState = computed<PageState>(() =>
  encodeNgState({ view: view.value, open: openId.value, q: search.value, show: nodeFilter.value, groups: [...groupsOpen.value] }),
);

let hostKeepsState = false;
let stateSender: StateSender | undefined;

/* The state goes out only after init, and only once the operator changes
 * something: the page's reading of the address (defaults filled in, unknown
 * values dropped) is not a reason to rewrite a pasted link. `hostState` is
 * undefined from a host that keeps no page state. */
function adoptPageState(hostState: PageState | undefined): void {
  hostKeepsState = hostState !== undefined;
  if (hostState) applyState(decodeNgState(hostState));
  stateSender?.dispose();
  stateSender = createStateSender((state) => bridge?.sendState(state), { baseline: pageState.value });
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
      adoptPageState(value.pageState);
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

/* After a failed overview read the rules in hand are empty or left over from
 * an earlier read; the join then lists every port and judges none of them. */
const views = computed<ExposureRowView[]>(() =>
  posture.value.map((row) => ({
    row,
    exposure: computeExposure(row, realityByNode.value.get(row.nodeId), exposureContext.value, knockByNode.value.get(row.nodeId), !overviewFailed.value),
    detail: detailStateFor(row),
  })),
);

const readingSnapshots = computed(
  () => detailProgress.value.total > 0 && detailProgress.value.done < detailProgress.value.total,
);

// ── Overview ────────────────────────────────────────────────────────────────

const attention = computed(() =>
  attentionItems(views.value, { canSeeReality: canSeeReality.value, realityFailed: realityFailed.value, overviewFailed: overviewFailed.value }),
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
  layerQuery.nodes = "";
  nodeFilter.value = "attention";
  showNodes();
}

/** A picture row opens Nodes on its exact port search, which lists the nodes the row counted. */
function showPort(port: string): void {
  layerQuery.nodes = port;
  nodeFilter.value = "all";
  showNodes();
}

/* From a control low on the Overview, Nodes opens at its top, where the
 * search and the match count say what the list holds; the document kept the
 * Overview's scroll and landed mid-table. */
function showNodes(): void {
  view.value = "nodes";
  window.scrollTo({ top: 0 });
}

// ── Nodes ───────────────────────────────────────────────────────────────────

const sortKey = ref<ExposureSortKey>("attention");
const sortDirection = ref<"asc" | "desc">("asc");
/**
 * The settled display order. Rows are read through it rather than sorted
 * live, because the default order ranks by each row's verdict and every node
 * reads as "Reading" until its own snapshot read returns: a live sort moves
 * the row under the pointer for the first seconds after load.
 */
const order = ref<OrderIndex>(new Map());

function settle(): void {
  // The same verdicts the Status column draws (ExposureTable passes the same
  // two flags to nodeStatus), so the default order and the dots agree.
  order.value = settleOrder(views.value, sortKey.value, sortDirection.value, attentionComparator(canSeeReality.value, !realityFailed.value));
}

function onSort(key: ExposureSortKey): void {
  // A header click takes the order back from a query that sorts, the way the
  // console's tables do: the query keeps its filter and loses its sort: terms,
  // and the column sorts from its first direction.
  if (nodesQuery.sorted.value) {
    layerQuery.nodes = withoutSorts(layerQuery.nodes);
    sortKey.value = key;
    sortDirection.value = "asc";
  } else if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDirection.value = "asc";
  }
  settle();
}

const attentionCount = computed(() => views.value.filter(needsAttention).length);
const filteredViews = computed(() => (nodeFilter.value === "attention" ? views.value.filter(needsAttention) : views.value));
/** The filter's rows in the settled order; the query keeps that order unless it sorts or a bare word ranks the rows. */
const orderedViews = computed(() => applyOrder(filteredViews.value, order.value));

/* Each list layer runs the console's list query over its own rows and
 * fields (listQueries.ts). The schemas are built once; what they read from
 * the page (what the session may read, the rules that name an id) is read
 * when the query runs. */
const nodesQuery = useListQuery(
  orderedViews,
  nodesQuerySchema(() => ({ canSeeReality: canSeeReality.value, realityRead: !realityFailed.value, groups: overview.value.groups, zones: overview.value.zones })),
  toRef(layerQuery, "nodes"),
);
const matchedViews = computed(() => nodesQuery.rows.value);
/** "port:22/tcp", the search a picture row opens, for the no-match copy. */
const portQuery = computed(() => parsePortQuery(layerQuery.nodes.trim().toLowerCase()));

/** The header's mark: the column's own sort, or the column the query's first sort: names, or none. */
const headerSort = computed<{ key: ExposureSortKey; direction: "asc" | "desc" } | null>(() => {
  if (!nodesQuery.sorted.value) return { key: sortKey.value, direction: sortDirection.value };
  const first = nodesQuery.active.value.sorts[0]!;
  const key = ({ status: "attention", name: "name", seen: "seen" } as Partial<Record<string, ExposureSortKey>>)[first.field.key];
  return key ? { key, direction: first.desc ? "desc" : "asc" } : null;
});

const groupsSchema = groupsQuerySchema(() => ({ context: exposureContext.value, nodes: overview.value.nodes }));
const groupsQuery = useListQuery(
  computed(() => overview.value.groups),
  groupsSchema,
  toRef(layerQuery, "groups"),
);
const matchedGroups = computed(() => groupsQuery.rows.value);
/* On Groups a query that reaches inside a rule opens the group while it
 * stands, because the operator asked for the rule, not the group; clearing
 * the query restores their own set. */
const groupsReached = computed(() =>
  groupsQuery.filtering.value ? groupsReachedByQuery(groupsQuery.active.value.source, matchedGroups.value, groupsSchema, exposureContext.value) : new Set<string>(),
);

const zonesQuery = useListQuery(
  computed(() => overview.value.zones),
  zonesQuerySchema(() => ({ nodes: overview.value.nodes })),
  toRef(layerQuery, "zones"),
);
const matchedZones = computed(() => zonesQuery.rows.value);

function toggleGroup(groupId: string): void {
  const next = new Set(groupsOpen.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  groupsOpen.value = next;
}

function groupOpen(groupId: string): boolean {
  return groupsOpen.value.has(groupId) || groupsReached.value.has(groupId);
}

const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(matchedViews.value.length / NODE_PAGE_SIZE)));
const pageStart = computed(() => (Math.min(page.value, pageCount.value) - 1) * NODE_PAGE_SIZE);
const pageViews = computed(() => matchedViews.value.slice(pageStart.value, pageStart.value + NODE_PAGE_SIZE));
watch([search, nodeFilter], () => {
  page.value = 1;
});

function nodeMenu(row: PostureRow): MenuItem[] {
  // Which action applies, and why one is closed, is read from the binding; a
  // failed overview read leaves none or an old one, so the menu offers nothing.
  if (overviewFailed.value) return [];
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
  // Coverage is read from the binding, which a failed overview read did not return.
  const parts = [row.nodeId, overviewFailed.value ? "binding not read" : coverageLabel(row.coverage)];
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
 * Close the panel. Focus goes back to the row of the node that is open now:
 * with the panel non-modal a row click swaps the node, so that is not always
 * the row that first opened it, and a panel the address opened (a reload, a
 * pasted link) had no opener at all. By id, never through a selector: the
 * id came from the address.
 */
const panelReturn = ref<HTMLElement | null>(null);
function closeNode(): void {
  const closed = openId.value;
  panelReturn.value = closed ? (document.getElementById(`node-${closed}`)?.querySelector<HTMLElement>(".ng-row-open") ?? null) : null;
  openId.value = "";
  panelNotice.value = "";
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

/** The review request's failure; a compile error travels in the review itself. */
function reviewErrorFor(nodeId: string): string {
  return reviewErrors.value.get(nodeId) || "";
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
/** Ages on this page count from now; the instants they count from are here. */
const now = useNow();
const proofTitle = computed(() => {
  if (!observedAt.value) return "";
  const fetched = `This page read the fleet at ${clockUtc(observedAt.value)}. Refresh to read it again.`;
  return newestObserved.value ? `Newest node snapshot ${stampUtc(newestObserved.value)}. ${fetched}` : `No node has reported a snapshot. ${fetched}`;
});
/**
 * The proof line says what the page knows and nothing it does not: when the
 * newest snapshot was taken, how many nodes report, how many of those are
 * stale or never reported. A read that failed prints no count at all.
 */
const proofSegments = computed(() => {
  if (realityFailed.value && overviewFailed.value) return ["not read: neither the overview nor node reality answered"];
  if (realityFailed.value) return ["node reality not read", "intent only, see the notice below"];
  // A session that cannot read reality never asked any node, so it counts
  // what was declared and claims no node "never reported".
  if (!canSeeReality.value) return ["reality not readable", `${plural(counts.value.total, "node", "nodes")} declared`];
  const segments: string[] = [];
  // The console's form: a relative age here, the absolute instant in the line's title.
  if (newestObserved.value) segments.push(`observed ${ageLabel(newestObserved.value, now.value)} ago`);
  else segments.push("not observed yet");
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

/** The query bar of the layer on screen: its query, its words, its count and its examples. The count sits inside the field's end. */
const layerBar = computed(() => {
  if (view.value === "groups") {
    return {
      query: groupsQuery,
      label: "Search, filter and sort groups",
      placeholder: "Search groups, or port:22 action:deny",
      count: { shown: matchedGroups.value.length, total: overview.value.groups.length },
      examples: GROUPS_QUERY_EXAMPLES,
    };
  }
  if (view.value === "zones") {
    return {
      query: zonesQuery,
      label: "Search, filter and sort zones",
      placeholder: "Search zones, or cidr:10.7 -is:builtin",
      count: { shown: matchedZones.value.length, total: overview.value.zones.length },
      examples: ZONES_QUERY_EXAMPLES,
    };
  }
  return {
    query: nodesQuery,
    label: "Search, filter and sort nodes",
    placeholder: "Search nodes, or status:drifted port:22/tcp",
    count: { shown: matchedViews.value.length, total: filteredViews.value.length },
    examples: NODES_QUERY_EXAMPLES,
  };
});
/* While the query on screen does not read, the rows below answer an earlier
 * one: the panel is dimmed and inert, as the console's lists are, so nobody
 * opens or acts on a row for a query they cannot see. */
const layerStale = computed(() => layerBar.value.query.invalid.value);
/** Rows the current layer has before any search or filter. */
const layerRows = computed(() => {
  if (view.value === "nodes") return posture.value.length;
  if (view.value === "groups") return overview.value.groups.length;
  if (view.value === "zones") return overview.value.zones.length;
  return 0;
});
/** The layer's toolbar and its creating verb (viewState.ts holds both rules). */
const showToolbar = computed(() =>
  showLayerToolbar({ loading: loading.value, bootError: Boolean(bootError.value), view: view.value, rows: layerRows.value, q: search.value, show: nodeFilter.value }),
);
const toolbarVerb = computed(() => createVerb({ canAdmin: canAdmin.value, overviewFailed: overviewFailed.value, view: view.value }));
/** The Nodes filter, each option with its count; a count nobody could read is left off (viewState.ts). */
const filterOptions = computed(() =>
  nodeFilterOptions({
    pending: loading.value || Boolean(bootError.value),
    total: counts.value.total,
    attention: attentionCount.value,
    canSeeReality: canSeeReality.value,
    realityFailed: realityFailed.value,
    overviewFailed: overviewFailed.value,
  }),
);
/** What the Nodes rows cannot claim, said once beside the filter instead of in a card header. */
const nodesNote = computed(() => {
  if (realityFailed.value) return "intent only: reality not read";
  if (overviewFailed.value) return "rules not read, ports not judged";
  return "";
});
/** The Nodes attention filter with nothing in it: an all-clear only for what was read. */
const attentionEmpty = computed(() =>
  attentionEmptyCopy({
    realityRead: canSeeReality.value && !realityFailed.value,
    realityScoped: canSeeReality.value,
    rulesRead: !overviewFailed.value,
    reading: readingSnapshots.value,
  }),
);
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

    <!-- With nothing loaded, the "Nothing could be loaded" block below carries
         the failure and its one Try again; this notice is for a partial read. -->
    <PcNotice v-if="error && posture.length" dismissible title="Part of this page could not be loaded" @dismiss="error = ''">
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

    <!-- The layers: an underline row of their own, above the layer's own
         toolbar (design review of wave 1, "Tab decision"). The row keeps the
         selected layer in view itself, again when the counts land. -->
    <PcLensTabs v-model="view" variant="layer" label="NetGuard layers">
      <PcLensTab value="overview" label="Overview" />
      <PcLensTab value="nodes" label="Nodes" :count="tabCount(counts.total, realityFailed)" />
      <PcLensTab value="groups" label="Groups" :count="tabCount(overview.groups.length, overviewFailed)" />
      <PcLensTab value="zones" label="Zones" :count="tabCount(overview.zones.length, overviewFailed)" />
    </PcLensTabs>

    <PcToolbar v-if="showToolbar" label="NetGuard toolbar" :data-view="view">
      <template v-if="view === 'nodes'" #tabs>
        <FilterSwitch v-model="nodeFilter" :options="filterOptions" label="Which nodes to show" />
      </template>
      <template #search>
        <!-- One bar per layer (the key): each has its own fields, menu and recent queries. -->
        <PcQueryBar
          :key="view"
          v-model="search"
          :query="layerBar.query"
          :count="layerBar.count"
          :label="layerBar.label"
          :placeholder="layerBar.placeholder"
          :storage-key="`netguard.${view}`"
          :examples="layerBar.examples"
        />
      </template>
      <template v-if="view === 'nodes' && nodesNote" #note>{{ nodesNote }}</template>
      <template v-else-if="view !== 'nodes' && permissionNote" #note>{{ permissionNote }}</template>
      <!-- The creating verb lives on the layer it creates in, and only once that layer was read. -->
      <template v-if="toolbarVerb" #primary>
        <PcButton v-if="toolbarVerb === 'zone'" variant="primary" @click="openZone()"><template #icon><Plus :size="15" /></template>New zone</PcButton>
        <PcButton v-else variant="primary" @click="openGroup()"><template #icon><Plus :size="15" /></template>New group</PcButton>
      </template>
    </PcToolbar>

    <PcPanel v-if="bootError" label="No session">
      <PcEmptyState kind="handshake" title="The console has not answered">
        <p>{{ bootError }}</p>
        <template #actions><PcButton @click="reloadPage">Reload the page</PcButton></template>
      </PcEmptyState>
    </PcPanel>

    <!-- The skeleton has the shape of the layer it stands in for: the Overview
         has a numbers strip, the collection layers have rows only. -->
    <template v-else-if="loading">
      <PcSkeleton v-if="view === 'overview'" variant="strip" :count="4" label="Loading the firewall summary" />
      <PcPanel label="Loading">
        <PcSkeleton :count="8" label="Loading firewall state: the declared intent and every node's last snapshot" />
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

    <!-- No card header: the selected layer already names this list, and its
         counts sit on the filter above it. The card holds the rows only. -->
    <PcPanel v-else-if="view === 'nodes'" id="pc-panel-nodes" role="tabpanel" aria-labelledby="pc-tab-nodes" :data-stale="layerStale ? 'true' : undefined" :inert="layerStale || undefined">
      <PcEmptyState v-if="!posture.length" title="No nodes are visible">
        <template #icon><Radar :size="26" /></template>
        <p>This session can see no nodes at all. A node appears here once its agent reports, or once it is bound to a security group.</p>
      </PcEmptyState>
      <PcEmptyState v-else-if="!filteredViews.length" :title="attentionEmpty.title">
        <template #icon><ShieldCheck v-if="attentionEmpty.allClear" :size="26" /><Radar v-else :size="26" /></template>
        <p>{{ attentionEmpty.body }}</p>
        <template #actions><PcButton @click="nodeFilter = 'all'">Show all nodes</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else-if="!matchedViews.length" kind="no-match" title="No node matches that query">
        <template #icon><Radar :size="26" /></template>
        <p v-if="portQuery">No node in {{ plural(filteredViews.length, 'node', 'nodes') }} has <span class="pc-mono">{{ search.trim() }}</span> open on a fresh snapshot that was read. A <span class="pc-mono">port:</span> term matches that exact port or bank, the way the Overview's picture counts it.</p>
        <p v-else>Nothing in {{ plural(filteredViews.length, 'node', 'nodes') }} matches <span class="pc-mono">{{ nodesQuery.active.value.source.trim() }}</span>. A bare word searches node name and id, groups, zones, open ports and their owning process; the help beside the field lists the fields, such as <span class="pc-mono">status:</span> and <span class="pc-mono">port:22/tcp</span>.</p>
        <template #actions><PcButton @click="search = ''">Clear the query</PcButton></template>
      </PcEmptyState>

      <ExposureTable
        v-else
        :rows="pageViews"
        :sort-key="headerSort?.key ?? null"
        :sort-direction="headerSort?.direction ?? 'asc'"
        :active-id="openId"
        :menu-for="nodeMenu"
        :ignored="ignored"
        :now="now"
        :can-see-reality="canSeeReality"
        :reality-read="!realityFailed"
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

    <PcPanel v-else-if="view === 'groups'" id="pc-panel-groups" role="tabpanel" aria-labelledby="pc-tab-groups" :data-stale="layerStale ? 'true' : undefined" :inert="layerStale || undefined">
      <p class="ng-layer-note">Ordered rules, attached to one or more nodes. The chain policy stays default drop, so anything no rule accepts is dropped. A group folds its rules underneath.</p>
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
      <PcEmptyState v-else-if="overview.groups.length" kind="no-match" title="No group matches that query">
        <template #icon><Boxes :size="26" /></template>
        <p>Nothing in {{ plural(overview.groups.length, 'group', 'groups') }} matches <span class="pc-mono">{{ groupsQuery.active.value.source.trim() }}</span>. A bare word searches group name, id and description, and each rule's sentence and comment; <span class="pc-mono">port:22</span> finds the rules that name a port.</p>
        <template #actions><PcButton @click="search = ''">Clear the query</PcButton></template>
      </PcEmptyState>
      <PcEmptyState v-else title="No security groups">
        <template #icon><Boxes :size="26" /></template>
        <p>A group is a reusable, ordered rule set. Create one, then attach it to a managed node in that node's binding.</p>
        <template v-if="canAdmin" #actions>
          <PcButton variant="primary" @click="openGroup()"><template #icon><Plus :size="15" /></template>New group</PcButton>
        </template>
      </PcEmptyState>
    </PcPanel>

    <PcPanel v-else id="pc-panel-zones" role="tabpanel" aria-labelledby="pc-tab-zones" :data-stale="layerStale ? 'true' : undefined" :inert="layerStale || undefined">
      <p class="ng-layer-note">Interfaces and CIDRs a node accepts before any security group is evaluated, once its binding trusts the zone. A built-in zone is defined on every node; loopback is always accepted.</p>
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
      <PcEmptyState v-else-if="overview.zones.length" kind="no-match" title="No zone matches that query">
        <template #icon><ShieldCheck :size="26" /></template>
        <p>Nothing in {{ plural(overview.zones.length, 'zone', 'zones') }} matches <span class="pc-mono">{{ zonesQuery.active.value.source.trim() }}</span>. A bare word searches zone name, id and description, interfaces and CIDRs.</p>
        <template #actions><PcButton @click="search = ''">Clear the query</PcButton></template>
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
      :return-focus-to="panelReturn"
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
          :rules-read="!overviewFailed"
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
