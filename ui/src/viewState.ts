/**
 * The NetGuard page's own state, as the console address carries it.
 *
 * `view` is the layer (Overview is the default and is left out of the
 * address), `open` the node whose panel is open, `q` the search on the
 * collection layers, `show` the Nodes filter, and `groups` the groups
 * unfolded on the Groups layer, comma-joined. Links from before the
 * layers still land: `lens=exposure` is Nodes, `lens=attention` is Overview
 * (the attention list opens it), and `expand=<id>` or `node=<id>` opens that
 * node's panel.
 */
import { PAGE_STATE_MAX_VALUE_LENGTH, putState, type PageState } from "./pageState";

export type NgView = "overview" | "nodes" | "groups" | "zones";
export const NG_VIEWS: readonly NgView[] = ["overview", "nodes", "groups", "zones"];

/** The Nodes filter: every node, or only the ones the attention list names. */
export type NodeFilter = "all" | "attention";
export const NODE_FILTERS: readonly NodeFilter[] = ["all", "attention"];

export interface NgPageState {
  view: NgView;
  open: string;
  q: string;
  show: NodeFilter;
  /** Group ids unfolded on the Groups layer. */
  groups: string[];
}

export const DEFAULT_NG_STATE: Readonly<NgPageState> = { view: "overview", open: "", q: "", show: "all", groups: [] };

/** Comma-joined ids that fit one page-state value; ids past the limit stay out rather than breaking the value. */
function joinIds(ids: readonly string[]): string {
  let out = "";
  for (const id of ids) {
    const next = out ? `${out},${id}` : id;
    if (next.length > PAGE_STATE_MAX_VALUE_LENGTH) break;
    out = next;
  }
  return out;
}

function splitIds(value: string | undefined): string[] {
  return (value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

const LEGACY_LENS: Record<string, NgView> = { exposure: "nodes", attention: "overview", groups: "groups", zones: "zones" };

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** State to address entries. Defaults stay out, so the default layer has a bare address. */
export function encodeNgState(state: NgPageState): PageState {
  const out: PageState = {};
  putState(out, "view", state.view, DEFAULT_NG_STATE.view);
  putState(out, "open", state.open);
  // The search narrows the collection layers; Overview has no search field,
  // so a search typed on Nodes is not carried into an Overview link.
  if (state.view !== "overview") putState(out, "q", state.q.trim());
  if (state.view === "nodes") putState(out, "show", state.show, DEFAULT_NG_STATE.show);
  if (state.view === "groups") putState(out, "groups", joinIds(state.groups));
  return out;
}

/** Address entries back to state. Anything unknown falls back to the default, so a stale or hand-edited link still opens a page. */
export function decodeNgState(state: PageState): NgPageState {
  const view = pick(state.view, NG_VIEWS) ?? LEGACY_LENS[state.lens ?? ""] ?? DEFAULT_NG_STATE.view;
  const legacyNode = (state.expand ?? "").split(",").map((id) => id.trim()).find(Boolean) ?? state.node ?? "";
  return {
    view,
    open: state.open ?? legacyNode,
    q: state.q ?? "",
    show: pick(state.show, NODE_FILTERS) ?? DEFAULT_NG_STATE.show,
    groups: splitIds(state.groups),
  };
}

/** What the node panel on `open=<id>` can honestly show. */
export type NodePanelState = "found" | "loading" | "unread" | "missing";

/**
 * "missing" is a claim that the node is not in the fleet, so only a read that
 * landed may make it. While nothing has landed or failed the panel is
 * loading; once the read that lists nodes has failed, the node was not read.
 */
export function nodePanelState(input: { found: boolean; loading: boolean; readFailed: boolean }): NodePanelState {
  if (input.found) return "found";
  if (input.loading) return "loading";
  return input.readFailed ? "unread" : "missing";
}

/** The panel title for a node the panel could not show; a found node titles the panel with its name. */
export const PANEL_TITLE: Record<NodePanelState, string> = {
  found: "",
  loading: "Loading node",
  unread: "Node not read",
  missing: "Node not found",
};
