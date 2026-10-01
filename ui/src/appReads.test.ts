// @vitest-environment jsdom
/**
 * When the mounted page reads, measured on the page itself. App.vue runs in
 * a DOM with fake timers against a stand-in host that speaks the bridge
 * protocol, and the test counts what reaches the host. It holds however a
 * poll or a height report would be written (setInterval under another name,
 * a recursive setTimeout, a helper around either), where sourcePolicy.test.ts
 * can only look for the text of one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type App as VueApp } from "vue";

import App from "./App.vue";

const HOST = "http://console.test";
const NONCE = "netguard-reads-test-nonce";
const SERVICE = "latticenet.netguard/firewall";
const COLLECTED = "2026-09-30T09:59:30Z";

const overview = {
  groups: [],
  zones: [],
  nodes: [
    {
      node_id: "node_cd-build-1",
      node_name: "cd-build-1",
      source: "stored",
      binding: { node_id: "node_cd-build-1", group_ids: [], managed: false, version: 1 },
      groups: [],
      zones: [],
    },
  ],
};
const realityList = {
  nodes: [{ node_id: "node_cd-build-1", node_name: "cd-build-1", snapshot_status: "fresh", drift_state: "unknown", collected_at: COLLECTED }],
};
const realityDetail = {
  node: {
    node_id: "node_cd-build-1",
    snapshot_status: "fresh",
    reality: {
      node_id: "node_cd-build-1",
      collected_at: COLLECTED,
      listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 22, process: "sshd" }],
      interfaces: [{ name: "eth0", addresses: ["203.0.113.4/24"], up: true }],
    },
  },
};

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

let calls: Call[] = [];
/** The type of every message the page posted to the host. */
let posted: string[] = [];
let app: VueApp | undefined;

function fromHost(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: { nonce: NONCE, ...data }, origin: HOST, source: window }));
}

function answer(call: Call): unknown {
  if (call.method === "overview") return overview;
  if (call.method === "reality") return call.payload.node_id ? realityDetail : realityList;
  return undefined;
}

/** What the page asked the host for, by method; a reality read counts its list and detail calls apart. */
function tally(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const key = call.method === "reality" ? (call.payload.node_id ? "reality detail" : "reality list") : call.method;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Lets the handshake and the reads chain through their promises. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
  window.location.hash = `#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(HOST)}`;
  calls = [];
  posted = [];
  // The frame's parent is the window itself in this DOM, so the page's
  // messages to the host arrive here.
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const data = message as { type?: string; id?: string; method?: string; payload?: Record<string, unknown> };
    posted.push(data.type ?? "");
    if (data.type === "lattice.plugin.ready") {
      queueMicrotask(() =>
        fromHost({
          type: "lattice.host.init",
          version: "1",
          pluginId: "latticenet.netguard",
          pluginVersion: "0.0.0-test",
          pluginRoute: "firewall",
          locale: "en",
          colorScheme: "dark",
          designTokens: {},
          interfaces: [{ service: SERVICE, methods: ["overview", "reality", "review"] }],
          pageState: {},
        }),
      );
    }
    if (data.type === "lattice.plugin.call") {
      const call = { method: data.method ?? "", payload: data.payload ?? {} };
      calls.push(call);
      queueMicrotask(() => fromHost({ type: "lattice.host.result", id: data.id, result: answer(call) }));
    }
  });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(App);
  app.mount(root);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the mounted page's reads", () => {
  it("reads once on open, nothing more on its own, and again on Refresh, and never reports a height", async () => {
    await settle();
    expect(tally()).toEqual({ overview: 1, "reality list": 1, "reality detail": 1 });
    expect(document.body.textContent).toContain("22/tcp");

    // The poll this page used to run fired every 20 seconds.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(tally()).toEqual({ overview: 1, "reality list": 1, "reality detail": 1 });

    const refresh = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    expect(refresh).toBeDefined();
    refresh!.click();
    await settle();
    expect(tally()).toEqual({ overview: 2, "reality list": 2, "reality detail": 2 });
    expect(posted).not.toContain("lattice.plugin.resize");
  });
});
