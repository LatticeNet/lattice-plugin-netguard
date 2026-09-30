/**
 * The NetGuard page's own state, as the console address carries it.
 *
 * `view` is the layer (Overview is the default and is left out of the
 * address), `open` the node whose panel is open, `q` the search on the
 * collection layers, and `show` the Nodes filter. Links from before the
 * layers still land: `lens=exposure` is Nodes, `lens=attention` is Overview
 * (the attention list opens it), and `expand=<id>` or `node=<id>` opens that
 * node's panel.
 */
import { putState, type PageState } from "./pageState";

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
}

export const DEFAULT_NG_STATE: Readonly<NgPageState> = { view: "overview", open: "", q: "", show: "all" };

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
  };
}
