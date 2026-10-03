import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAGE_STATE_MAX_VALUE_LENGTH,
  createStateSender,
  filterPageState,
  pageStateKey,
  validPageState,
  type PageState,
} from "./pageState";
import { DEFAULT_NG_STATE, decodeNgState, encodeNgState, type NgPageState } from "./viewState";

// The contract's rules themselves (validPageState) are the bridge client's
// and are tested in @latticenet/plugin-bridge.
describe("page state rules", () => {
  it("filters an address entry by entry, leaving out repeats, reserved keys and extras past 16", () => {
    const query = new URLSearchParams(`view=nodes&Bad=1&expand=a&expand=b&next=/x&q=${"x".repeat(257)}&open=n1`);
    expect(filterPageState(query)).toEqual({ view: "nodes", open: "n1" });
    const many = Array.from({ length: 20 }, (_, index) => [`k${index}`, "v"] as const);
    expect(Object.keys(filterPageState(many))).toEqual(many.slice(0, 16).map(([key]) => key));
  });

  it("compares states regardless of key order", () => {
    expect(pageStateKey({ view: "nodes", q: "pg" })).toBe(pageStateKey({ q: "pg", view: "nodes" }));
    expect(pageStateKey({ view: "nodes" })).not.toBe(pageStateKey({ view: "groups" }));
  });
});

describe("sending state to the host", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends once the page has been quiet for the debounce, and only the latest state", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value));
    sender.push({ view: "nodes" });
    vi.advanceTimersByTime(200);
    sender.push({ view: "nodes", q: "p" });
    vi.advanceTimersByTime(200);
    sender.push({ view: "nodes", q: "postgres" });
    vi.advanceTimersByTime(249);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ view: "nodes", q: "postgres" }]);
  });

  it("sends nothing when the state is what the host already has", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value), { baseline: { view: "nodes", open: "n1" } });
    sender.push({ open: "n1", view: "nodes" });
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
    sender.push({});
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{}]);
  });

  it("spaces sends so a minute never holds more than the host's 60, and the last state lands", () => {
    vi.useFakeTimers();
    const sent: Array<{ at: number; state: PageState }> = [];
    const start = Date.now();
    const sender = createStateSender((value) => sent.push({ at: Date.now() - start, state: value }));
    for (let index = 0; index < 400; index += 1) {
      sender.push({ view: index % 2 ? "nodes" : "groups", q: String(index) });
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(5_000);
    for (const { at } of sent) {
      expect(sent.filter((other) => other.at > at - 60_000 && other.at <= at).length).toBeLessThanOrEqual(60);
    }
    expect(sent.at(-1)?.state).toEqual({ view: "nodes", q: "399" });
  });

  it("sends nothing after dispose", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value));
    sender.push({ view: "zones" });
    sender.dispose();
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
  });
});

describe("the NetGuard page's own state", () => {
  const state = (patch: Partial<NgPageState> = {}): NgPageState => ({ ...DEFAULT_NG_STATE, ...patch });

  it.each<[NgPageState, PageState]>([
    [state(), {}],
    [state({ view: "nodes" }), { view: "nodes" }],
    [state({ view: "nodes", q: "postgres", show: "attention", open: "metix-dmit-2" }), { view: "nodes", open: "metix-dmit-2", q: "postgres", show: "attention" }],
    [state({ view: "groups", q: "relay" }), { view: "groups", q: "relay" }],
    [state({ open: "fra-exit-02" }), { open: "fra-exit-02" }],
    [state({ view: "groups", groups: ["ssh", "relay-hub"] }), { view: "groups", groups: "ssh,relay-hub" }],
  ])("round-trips %#", (value, encoded) => {
    expect(encodeNgState(value)).toEqual(encoded);
    expect(validPageState(encodeNgState(value))).toEqual(encoded);
    expect(decodeNgState(encoded)).toEqual(value);
  });

  it("keeps a search and a filter out of the address where the layer has none", () => {
    expect(encodeNgState(state({ view: "overview", q: "postgres", show: "attention" }))).toEqual({});
    expect(encodeNgState(state({ view: "groups", show: "attention" }))).toEqual({ view: "groups" });
    expect(encodeNgState(state({ view: "nodes", q: "  pg  " }))).toEqual({ view: "nodes", q: "pg" });
    expect(encodeNgState(state({ view: "nodes", q: "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH + 1) }))).toEqual({ view: "nodes" });
  });

  it("carries unfolded groups only on the Groups layer, and only as many ids as fit", () => {
    expect(encodeNgState(state({ view: "nodes", groups: ["ssh"] }))).toEqual({ view: "nodes" });
    const many = Array.from({ length: 40 }, (_, index) => `group-${String(index).padStart(2, "0")}`);
    const encoded = encodeNgState(state({ view: "groups", groups: many })).groups!;
    expect(encoded.length).toBeLessThanOrEqual(PAGE_STATE_MAX_VALUE_LENGTH);
    expect(encoded.startsWith("group-00,group-01,")).toBe(true);
    expect(encoded.split(",").every((id) => many.includes(id))).toBe(true);
    expect(decodeNgState({ view: "groups", groups: " ssh, ,relay-hub " }).groups).toEqual(["ssh", "relay-hub"]);
  });

  it("opens old links on the layer they meant", () => {
    expect(decodeNgState({ lens: "exposure" }).view).toBe("nodes");
    expect(decodeNgState({ lens: "attention" }).view).toBe("overview");
    expect(decodeNgState({ lens: "zones" }).view).toBe("zones");
    expect(decodeNgState({ view: "groups", lens: "zones" }).view).toBe("groups");
    expect(decodeNgState({ expand: "n2,n3" }).open).toBe("n2");
    expect(decodeNgState({ node: "n4" }).open).toBe("n4");
    expect(decodeNgState({ open: "n5", node: "n4" }).open).toBe("n5");
    expect(decodeNgState({ view: "planet", show: "everything" })).toEqual(state());
  });
});
