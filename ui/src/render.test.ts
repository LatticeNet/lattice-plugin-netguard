/**
 * The components, rendered. Each case renders the real single-file
 * component through Vue's server renderer with the props the page passes,
 * and reads the markup it produced, so a claim here is about what the
 * operator is shown, not about which strings a source file contains.
 */
import { describe, expect, it } from "vitest";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";

import ApplyDialog from "./components/ApplyDialog.vue";
import AttentionList from "./components/AttentionList.vue";
import ExposureTable from "./components/ExposureTable.vue";
import PortPicture from "./components/PortPicture.vue";
import { computeExposure, type ExposureContext } from "./exposure";
import type { GuardListener, GuardNodeReality } from "./netguardModel";
import { attentionItems, portPicture, type ExposureRowView } from "./overview";
import type { PostureRow } from "./posture";

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(component, props) }));
}

function listener(port: number, process: string, address = "0.0.0.0"): GuardListener {
  return { protocol: "tcp", address, port, process };
}

function reality(listeners: GuardListener[]): GuardNodeReality {
  return {
    node_id: "n",
    collected_at: "2026-09-30T10:00:00Z",
    listeners,
    interfaces: [{ name: "eth0", addresses: ["203.0.113.4/24"], up: true }],
  };
}

function row(nodeId: string, over: Partial<PostureRow> = {}): PostureRow {
  return {
    nodeId,
    nodeName: nodeId,
    coverage: "unbound",
    snapshotStatus: "fresh",
    driftState: "unknown",
    collectedAt: "2026-09-30T10:00:00Z",
    groupIds: [],
    zoneIds: [],
    ...over,
  };
}

const empty: ExposureContext = { groups: [], zones: [] };
const sockets = reality([listener(22, "sshd"), listener(5432, "postgres")]);

function views(rulesRead: boolean): ExposureRowView[] {
  return ["cd-build-1", "cd-lab-1"].map((id) => ({ row: row(id), exposure: computeExposure(row(id), sockets, empty, undefined, rulesRead), detail: "loaded" }));
}

const tableProps = (rows: ExposureRowView[]) => ({
  rows,
  sortKey: "attention",
  sortDirection: "asc",
  activeId: "",
  menuFor: () => [],
  ignored: new Set<string>(),
  now: Date.parse("2026-09-30T10:00:41Z"),
  canSeeReality: true,
});

describe("the Nodes table, rendered", () => {
  it("draws ports no rule allows in the attention style, with the reason for a screen reader", async () => {
    const html = await render(ExposureTable, tableProps(views(true)));
    expect(html.match(/class="ng-span-open"/g)).toHaveLength(4);
    expect(html).toContain("open with no rule allowing it");
    expect(html).toContain("41s ago");
  });

  it("draws no port as unexplained and no binding as none when the rules were not read", async () => {
    const html = await render(ExposureTable, tableProps(views(false)));
    expect(html).not.toContain('class="ng-span-open"');
    expect(html.match(/class="ng-span-unknown"/g)).toHaveLength(4);
    expect(html).toContain("the declared rules were not read, so whether a rule allows it is unknown");
    expect(html).toContain("not judged: the rules were not read");
    expect(html).toContain(">not read<");
    expect(html).not.toContain(">no binding<");
  });
});

describe("the port picture, rendered", () => {
  it("opens each row on its exact port search and colours only the no-rule part", async () => {
    const html = await render(PortPicture, { picture: portPicture(views(true)), reading: { done: 2, total: 2 } });
    expect(html).toContain("Opens Nodes on port:22/tcp, which lists these 2 nodes.");
    expect(html).toContain('<span data-attention="true">2 no rule</span>');
    expect(html).toContain("<span>2 nodes</span>");
  });

  it("says snapshots are still being read rather than that nothing is open", async () => {
    const html = await render(PortPicture, { picture: { rows: [], counted: 0, stale: 0, neverReported: 0, unread: 2 }, reading: { done: 0, total: 2 } });
    expect(html).toContain("Still reading snapshots");
    expect(html).not.toContain("Nothing is open to the internet");
  });
});

describe("the attention list, rendered", () => {
  it("renders nothing when nothing needs a hand", async () => {
    expect(await render(AttentionList, { items: [] })).toBe("<!---->");
  });

  it("carries no ports claim after a failed overview read", async () => {
    const items = attentionItems(views(false), { canSeeReality: true, realityFailed: false, overviewFailed: true });
    expect(await render(AttentionList, { items })).toBe("<!---->");
    const read = await render(AttentionList, { items: attentionItems(views(true), { canSeeReality: true, realityFailed: false, overviewFailed: false }) });
    expect(read).toContain("4 ports open to the internet with no rule, on 2 nodes");
  });
});

describe("the apply dialog, rendered", () => {
  it("names the verb its primary leads to", async () => {
    const html = await render(ApplyDialog, {
      open: true,
      row: row("n", { coverage: "managed", driftState: "in_sync" }),
      baseline: "",
      ruleset: "table inet lattice_guard {}",
      findings: [],
      compileError: "",
      planning: false,
      error: "",
    });
    expect(html).toContain("Create approval");
    expect(html).not.toMatch(/>\s*Continue\s*</);
  });
});
