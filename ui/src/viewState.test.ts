import { describe, expect, it } from "vitest";

import { DEFAULT_NG_STATE, createVerb, decodeNgState, nodePanelState, showLayerToolbar, type NgView } from "./viewState";

describe("the node panel's state", () => {
  it("says a node is missing only after a read that landed", () => {
    expect(nodePanelState({ found: false, loading: false, readFailed: false })).toBe("missing");
  });

  it("says the node was not read when the read that lists nodes failed", () => {
    // Not "missing": a 503 says nothing about whether the node exists.
    expect(nodePanelState({ found: false, loading: false, readFailed: true })).toBe("unread");
  });

  it("loads until a read lands or fails, and never spins after a failure", () => {
    expect(nodePanelState({ found: false, loading: true, readFailed: false })).toBe("loading");
    expect(nodePanelState({ found: false, loading: false, readFailed: true })).not.toBe("loading");
  });

  it("shows a node that is listed, whatever a later read did", () => {
    expect(nodePanelState({ found: true, loading: false, readFailed: true })).toBe("found");
  });
});

describe("the layer toolbar", () => {
  const base = { loading: false, bootError: false, view: "nodes" as NgView, rows: 33, q: "", show: "all" as const };

  it("opens on the Overview, which has no list and so no toolbar", () => {
    expect(DEFAULT_NG_STATE.view).toBe("overview");
    expect(decodeNgState({}).view).toBe("overview");
    expect(showLayerToolbar({ ...base, view: "overview" })).toBe(false);
  });

  it("shows on a layer with rows, and on an empty one only while a search or filter stands", () => {
    expect(showLayerToolbar(base)).toBe(true);
    expect(showLayerToolbar({ ...base, view: "zones", rows: 0 })).toBe(false);
    expect(showLayerToolbar({ ...base, view: "zones", rows: 0, q: "wg" })).toBe(true);
    expect(showLayerToolbar({ ...base, rows: 0, show: "attention" })).toBe(true);
    // The Nodes filter belongs to Nodes; it holds no toolbar open elsewhere.
    expect(showLayerToolbar({ ...base, view: "groups", rows: 0, show: "attention" })).toBe(false);
  });

  it("stays off while loading or without a session", () => {
    expect(showLayerToolbar({ ...base, loading: true })).toBe(false);
    expect(showLayerToolbar({ ...base, bootError: true })).toBe(false);
  });

  it("puts the creating verb on the layer it creates in, for an admin, once that layer was read", () => {
    expect(createVerb({ canAdmin: true, overviewFailed: false, view: "groups" })).toBe("group");
    expect(createVerb({ canAdmin: true, overviewFailed: false, view: "zones" })).toBe("zone");
    for (const view of ["overview", "nodes"] as const) expect(createVerb({ canAdmin: true, overviewFailed: false, view })).toBeNull();
    expect(createVerb({ canAdmin: false, overviewFailed: false, view: "groups" })).toBeNull();
    expect(createVerb({ canAdmin: true, overviewFailed: true, view: "zones" })).toBeNull();
  });
});
