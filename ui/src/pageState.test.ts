import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAGE_STATE_MAX_VALUE_LENGTH,
  channelFromHash,
  createStateSender,
  filterPageState,
  listenForInitPageState,
  pageStateKey,
  stateMessage,
  validPageState,
  type PageState,
} from "./pageState";
import { DEFAULT_NG_STATE, decodeNgState, encodeNgState, type NgPageState } from "./viewState";

const NONCE = "nonce-0123456789abcdef";
const HOST = "https://console.example.test";

describe("page state rules", () => {
  it("accepts a state inside the contract and drops the whole state on any bad entry", () => {
    expect(validPageState({ view: "nodes", open: "metix-dmit-2" })).toEqual({ view: "nodes", open: "metix-dmit-2" });
    expect(validPageState({})).toEqual({});
    expect(validPageState({ view: "nodes", Open: "x" })).toBeUndefined();
    expect(validPageState({ "9lives": "x" })).toBeUndefined();
    expect(validPageState({ ["a".repeat(25)]: "x" })).toBeUndefined();
    expect(validPageState({ ["a".repeat(24)]: "x" })).toEqual({ ["a".repeat(24)]: "x" });
    expect(validPageState({ q: "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH + 1) })).toBeUndefined();
    expect(validPageState({ q: "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH) })).toBeDefined();
    expect(validPageState({ view: 1 })).toBeUndefined();
    expect(validPageState({ token: "abc" })).toBeUndefined();
    expect(validPageState(null)).toBeUndefined();
    expect(validPageState(["view", "nodes"])).toBeUndefined();
    const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]));
    expect(validPageState(seventeen)).toBeUndefined();
    delete seventeen.k16;
    expect(validPageState(seventeen)).toBeDefined();
  });

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

  it("spells the outbound message the way the contract does", () => {
    expect(stateMessage(NONCE, { view: "zones" })).toEqual({ type: "lattice.plugin.state", nonce: NONCE, state: { view: "zones" } });
  });
});

describe("the channel from the frame fragment", () => {
  it("reads a nonce and an exact http(s) origin, and nothing else", () => {
    expect(channelFromHash(`#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(`${HOST}/path`)}`)).toEqual({ nonce: NONCE, hostOrigin: HOST });
    expect(channelFromHash(`#lattice_nonce=short&host_origin=${encodeURIComponent(HOST)}`)).toBeNull();
    expect(channelFromHash(`#lattice_nonce=${NONCE}`)).toBeNull();
    expect(channelFromHash(`#lattice_nonce=${NONCE}&host_origin=javascript%3Aalert(1)`)).toBeNull();
    expect(channelFromHash(`#lattice_nonce=${NONCE}&host_origin=not%20a%20url`)).toBeNull();
  });
});

describe("page state off the init message", () => {
  type Listener = (event: MessageEvent) => void;
  function fakeWindow() {
    const parent = {};
    const listeners = new Set<Listener>();
    return {
      parent,
      listeners,
      addEventListener: (_type: "message", listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: "message", listener: Listener) => listeners.delete(listener),
      deliver(data: unknown, options: { source?: unknown; origin?: string } = {}) {
        const event = { data, source: options.source ?? parent, origin: options.origin ?? HOST } as unknown as MessageEvent;
        for (const listener of listeners) listener(event);
      },
    };
  }
  const init = (extra: Record<string, unknown>) => ({ type: "lattice.host.init", nonce: NONCE, version: "1", ...extra });

  it("hands over the host's state, with a reserved key dropped on its own", () => {
    const win = fakeWindow();
    const seen: Array<PageState | undefined> = [];
    listenForInitPageState(win, { nonce: NONCE, hostOrigin: HOST }, (state) => seen.push(state));
    win.deliver(init({ pageState: { view: "nodes", open: "n1", next: "/evil" } }));
    expect(seen).toEqual([{ view: "nodes", open: "n1" }]);
  });

  it("says undefined when the host keeps no page state or breaks the rules", () => {
    const win = fakeWindow();
    const seen: Array<PageState | undefined> = [];
    listenForInitPageState(win, { nonce: NONCE, hostOrigin: HOST }, (state) => seen.push(state));
    win.deliver(init({}));
    win.deliver(init({ pageState: { View: "nodes" } }));
    win.deliver(init({ pageState: "view=nodes" }));
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it("ignores a message from another window, another origin, another nonce, or of another type", () => {
    const win = fakeWindow();
    const seen: Array<PageState | undefined> = [];
    const stop = listenForInitPageState(win, { nonce: NONCE, hostOrigin: HOST }, (state) => seen.push(state));
    win.deliver(init({ pageState: { view: "nodes" } }), { source: {} });
    win.deliver(init({ pageState: { view: "nodes" } }), { origin: "https://elsewhere.test" });
    win.deliver({ ...init({ pageState: { view: "nodes" } }), nonce: "another-nonce-0000000" });
    win.deliver({ ...init({ pageState: { view: "nodes" } }), type: "lattice.host.theme" });
    expect(seen).toEqual([]);
    stop();
    expect(win.listeners.size).toBe(0);
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
