import { describe, expect, it } from "vitest";

import { applyQuery, compileQuery, type QuerySchema } from "@latticenet/plugin-bridge/query";

import type { ExposureContext, NodeExposure, OpenSpan } from "./exposure";
import {
  GROUPS_QUERY_EXAMPLES,
  NODES_QUERY_EXAMPLES,
  NODE_STATUS_VALUES,
  ZONES_QUERY_EXAMPLES,
  groupsQuerySchema,
  groupsReachedByQuery,
  nodesQuerySchema,
  zonesQuerySchema,
  type NodesQueryContext,
} from "./listQueries";
import type { GuardNode, GuardRule, GuardZone, SecurityGroup } from "./netguardModel";
import { attentionComparator } from "./nodeStatus";
import type { DetailState, ExposureRowView } from "./overview";
import type { PostureRow } from "./posture";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function run<T>(schema: QuerySchema<T>, rows: readonly T[], text: string): T[] {
  const compiled = compileQuery(text, schema);
  if (!compiled.ok) throw new Error(`${text}: ${compiled.error.code}`);
  return applyQuery(rows, compiled.query, NOW);
}

function errorOf<T>(schema: QuerySchema<T>, text: string) {
  const compiled = compileQuery(text, schema);
  return compiled.ok ? undefined : compiled.error;
}

// ── the declared side ───────────────────────────────────────────────────────

function rule(id: string, over: Partial<GuardRule>): GuardRule {
  return { id, action: "allow", direction: "ingress", protocol: "tcp", ports: [], remote: { kind: "any" }, ...over };
}

const ZONES: GuardZone[] = [
  { id: "loopback", name: "loopback", builtin: true, interfaces: ["lo"], cidrs: ["127.0.0.0/8"] },
  { id: "public", name: "public", builtin: true },
  { id: "wireguard", name: "wg", builtin: true, interfaces: ["wg0"], cidrs: ["10.7.0.0/24"] },
  { id: "office", name: "Office VPN", cidrs: ["10.99.0.0/16"], description: "The office concentrator's client range." },
  { id: "lab", name: "lab", cidrs: ["192.168.50.0/24"] },
];

const GROUPS: SecurityGroup[] = [
  { id: "ssh", name: "ssh", version: 4, rules: [rule("ssh-any", { ports: [{ from: 22, to: 22 }], comment: "operator shell" })] },
  {
    id: "relay-hub",
    name: "relay-hub",
    version: 11,
    rules: [rule("bank", { ports: [{ from: 31001, to: 31012 }] }), rule("hy2", { protocol: "udp", ports: [{ from: 36712, to: 36712 }], comment: "Hysteria2" })],
  },
  { id: "web", name: "web", version: 2, rules: [rule("http", { ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }] })] },
  { id: "db-wg", name: "db-wg", version: 1, rules: [rule("pg", { ports: [{ from: 5432, to: 5432 }], remote: { kind: "zone", zone_id: "wireguard" }, comment: "postgres from the fleet" })] },
  {
    id: "monitoring",
    name: "monitoring",
    version: 3,
    rules: [
      rule("node-exporter", { ports: [{ from: 9100, to: 9100 }], remote: { kind: "cidr", cidr: "10.7.0.0/24" } }),
      rule("smtp-deny", { action: "deny", ports: [{ from: 25, to: 25 }], comment: "never relay mail" }),
    ],
  },
  { id: "egress-dns", name: "egress-dns", version: 1, rules: [rule("dns", { direction: "egress", protocol: "any", ports: [] })] },
  { id: "legacy:homeserver", name: "homeserver baseline", version: 1, source: "legacy", rules: [rule("l-ssh", { ports: [{ from: 22, to: 22 }] })] },
];

function intent(id: string, groupIds: string[], zoneIds: string[] = []): GuardNode {
  return {
    node_id: id,
    node_name: id,
    source: "stored",
    binding: { node_id: id, group_ids: groupIds, zone_ids: zoneIds, managed: true, version: 1 },
    groups: [],
    zones: [],
  };
}

const INTENT: GuardNode[] = [
  intent("hkg-edge-01", ["ssh", "relay-hub", "monitoring"], ["wireguard"]),
  intent("hkg-edge-02", ["ssh", "relay-hub"], ["wireguard"]),
  intent("db-1", ["ssh", "db-wg"], ["wireguard", "office"]),
];

const ctx: ExposureContext = { groups: GROUPS, zones: ZONES };

// ── the fleet as the Nodes table reads it ───────────────────────────────────

function span(from: number, verdict: OpenSpan["verdict"], processes: string[] = [], to = from, protocol: "tcp" | "udp" = "tcp"): OpenSpan {
  return { protocol, from, to, processes, verdict };
}

function view(id: string, over: Partial<PostureRow> = {}, open: OpenSpan[] = [], detail: DetailState = "loaded", managedBy: NodeExposure["managedBy"] = { kind: "none" }): ExposureRowView {
  const row: PostureRow = {
    nodeId: id,
    nodeName: id,
    coverage: "managed",
    snapshotStatus: "fresh",
    driftState: "in_sync",
    appliedTableSha: "a",
    managedSha: "a",
    collectedAt: ago(1),
    lastAppliedAt: ago(60 * 24),
    groupIds: [],
    zoneIds: [],
    ...over,
  };
  const exposure: NodeExposure = {
    nodeId: id,
    evidence: row.snapshotStatus === "unknown" ? "none" : row.snapshotStatus === "stale" ? "stale" : "fresh",
    open,
    confined: [],
    unexplained: open.filter((item) => item.verdict === "unexplained").reduce((sum, item) => sum + item.to - item.from + 1, 0),
    managedBy,
    enforced: row.coverage === "managed" && row.driftState === "in_sync",
    rulesRead: true,
  };
  return { row, exposure, detail };
}

const FLEET: ExposureRowView[] = [
  view("dmit-2", { driftState: "drift", groupIds: ["ssh", "db-wg"], zoneIds: ["wireguard"] }, [span(22, "allowed", ["sshd"]), span(5432, "unexplained", ["postgres"]), span(8080, "unexplained", ["nginx"])], "loaded", { kind: "groups", names: ["ssh", "db-wg"] }),
  view("lax-exit-02", { lastError: "selfcheck: control plane unreachable; rolled back", groupIds: ["ssh"] }, [span(22, "allowed", ["sshd"])]),
  view("hkg-edge-01", { groupIds: ["ssh", "relay-hub"], zoneIds: ["wireguard"], foreignTableCount: 1 }, [span(22, "allowed", ["sshd"]), span(31001, "allowed", ["sing-box"], 31012)]),
  view("build-1", { coverage: "observe_only", driftState: "unknown", appliedTableSha: undefined, groupIds: ["ssh"], zoneIds: ["office"], collectedAt: ago(30) }, [span(2375, "unexplained", ["dockerd"]), span(21, "allowed", ["vsftpd"], 23)]),
  view("lab-2", { coverage: "observe_only", driftState: "unknown", snapshotStatus: "stale", collectedAt: ago(60 * 5) }, [span(5432, "unexplained", ["postgres"])]),
  view("homeserver", { coverage: "legacy", driftState: "unknown", lastAppliedAt: undefined }, [span(2222, "allowed", ["sshd"])], "loaded", { kind: "legacy", names: ["homeserver baseline"] }),
  view("pi-zero", { coverage: "unbound", driftState: "unknown", snapshotStatus: "unknown", collectedAt: undefined, lastAppliedAt: undefined }),
  view("sin-edge-01", { groupIds: ["ssh"] }, [span(5432, "unexplained", ["postgres"])], "pending"),
];

const readable: NodesQueryContext = { canSeeReality: true, realityRead: true, groups: GROUPS, zones: ZONES };
const nodes = nodesQuerySchema(() => readable);
const ids = (rows: readonly ExposureRowView[]) => rows.map((item) => item.row.nodeId);

describe("the Nodes query", () => {
  it("reads every field it offers, and each example on the help card", () => {
    const terms = [
      "status:drifted",
      "verdict:no_rule",
      "coverage:observe_only",
      "posture:legacy",
      "drift:in_sync",
      "snapshot:never",
      "group:ssh",
      "zone:wireguard",
      "port:22/tcp",
      "process:postgres",
      "unexplained>0",
      "open>=2",
      "foreign>0",
      "seen>10m",
      "applied<2026-10-01",
      "is:attention",
      "is:drifted",
      "is:failed",
      "is:enforced",
      "name:dmit",
      "id:dmit-2",
      "sort:status,-unexplained,seen,applied,name",
    ];
    for (const text of [...terms, ...NODES_QUERY_EXAMPLES.map((example) => example.query)]) {
      expect(compileQuery(text, nodes).ok, text).toBe(true);
    }
  });

  it("names the field a typo meant, and refuses the console fields this contract cannot answer", () => {
    expect(errorOf(nodes, "stauts:drifted")).toMatchObject({ code: "unknownField", params: { field: "stauts", suggestion: "status" } });
    // The console's status words are about the agent; this column's are verdicts.
    expect(errorOf(nodes, "status:offline")).toMatchObject({ code: "unknownValue", params: { field: "status" } });
    expect(errorOf(nodes, "unexplained>many")).toMatchObject({ code: "badNumber" });
    // No online state, address or last report crosses the plugin contract.
    expect(errorOf(nodes, "last_seen>10m")).toMatchObject({ code: "unknownField" });
    expect(errorOf(nodes, "ip:10.7.0.1")).toMatchObject({ code: "unknownField" });
  });

  it("matches status on the verdict the Status column draws", () => {
    expect(ids(run(nodes, FLEET, "status:drifted OR status:apply_failed"))).toEqual(["dmit-2", "lax-exit-02"]);
    expect(ids(run(nodes, FLEET, "status:no_rule"))).toEqual(["build-1"]);
    expect(ids(run(nodes, FLEET, "status:never"))).toEqual(["pi-zero"]);
    expect(ids(run(nodes, FLEET, "status:reading"))).toEqual(["sin-edge-01"]);
    expect(ids(run(nodes, FLEET, "status:stale"))).toEqual(["lab-2"]);
  });

  it("sorts status in the order the Status header sorts, worst first", () => {
    const byHeader = [...FLEET].sort(attentionComparator(true, true));
    const byQuery = run(nodes, FLEET, "sort:status");
    expect(byQuery.map((item) => item.row.nodeId).slice(0, 3)).toEqual(byHeader.map((item) => item.row.nodeId).slice(0, 3));
    expect(NODE_STATUS_VALUES[0]).toBe("drifted");
    expect(NODE_STATUS_VALUES.at(-1)).toBe("enforced");
  });

  it("finds a port the way the Overview's picture counts it: that exact port or bank, on a fresh snapshot that was read", () => {
    // Not the 21-23 bank on build-1, not 2222 on homeserver.
    expect(ids(run(nodes, FLEET, "port:22/tcp"))).toEqual(["dmit-2", "lax-exit-02", "hkg-edge-01"]);
    expect(ids(run(nodes, FLEET, "port:31001-31012/tcp"))).toEqual(["hkg-edge-01"]);
    expect(ids(run(nodes, FLEET, "port:22/udp"))).toEqual([]);
    // lab-2 is stale and sin-edge-01 still reading: neither is counted.
    expect(ids(run(nodes, FLEET, "port:5432"))).toEqual(["dmit-2"]);
    expect(ids(run(nodes, FLEET, "port:22*"))).toEqual(["dmit-2", "lax-exit-02", "hkg-edge-01", "homeserver"]);
  });

  it("reads groups and zones by name or id, and the groups that manage a legacy node", () => {
    expect(ids(run(nodes, FLEET, "group:db-wg"))).toEqual(["dmit-2"]);
    expect(ids(run(nodes, FLEET, "group:baseline"))).toEqual(["homeserver"]);
    expect(ids(run(nodes, FLEET, "zone:wg"))).toEqual(["dmit-2", "hkg-edge-01"]);
    expect(ids(run(nodes, FLEET, 'zone:"office vpn"'))).toEqual(["build-1"]);
  });

  it("takes OR, negation and numbers together", () => {
    expect(ids(run(nodes, FLEET, "is:attention -process:postgres"))).toEqual(["lax-exit-02", "build-1"]);
    expect(ids(run(nodes, FLEET, "unexplained>0 sort:-unexplained"))).toEqual(["dmit-2", "build-1"]);
    expect(ids(run(nodes, FLEET, "(coverage:legacy OR coverage:unbound) -snapshot:never"))).toEqual(["homeserver"]);
    expect(ids(run(nodes, FLEET, "NOT group:ssh is:enforced"))).toEqual([]);
    expect(ids(run(nodes, FLEET, "foreign>=1"))).toEqual(["hkg-edge-01"]);
  });

  it("measures snapshot and apply ages, and leaves out a node with no time", () => {
    expect(ids(run(nodes, FLEET, "seen>10m"))).toEqual(["build-1", "lab-2"]);
    expect(ids(run(nodes, FLEET, "applied<2h"))).toEqual([]);
    expect(run(nodes, FLEET, "sort:seen").at(-1)!.row.nodeId).toBe("pi-zero");
  });

  it("says nothing about drift or snapshots that were not read", () => {
    const unread = nodesQuerySchema(() => ({ ...readable, realityRead: false }));
    expect(run(unread, FLEET, "drift:unknown")).toEqual([]);
    expect(run(unread, FLEET, "snapshot:never")).toEqual([]);
    expect(ids(run(unread, FLEET, "status:not_read"))).toEqual(["pi-zero"]);
    const intentOnly = nodesQuerySchema(() => ({ ...readable, canSeeReality: false }));
    expect(run(intentOnly, FLEET, "foreign>=0")).toEqual([]);
  });

  it("searches a bare word over name, groups, ports and their processes", () => {
    expect(ids(run(nodes, FLEET, "dockerd"))).toEqual(["build-1"]);
    expect(ids(run(nodes, FLEET, "hkg"))).toEqual(["hkg-edge-01"]);
    expect(ids(run(nodes, FLEET, "-sshd")).includes("lax-exit-02")).toBe(false);
  });
});

// ── Groups ──────────────────────────────────────────────────────────────────

const groupsRead = { context: ctx, nodes: INTENT };
const groups = groupsQuerySchema(() => groupsRead);
const groupIds = (rows: readonly SecurityGroup[]) => rows.map((group) => group.id);

describe("the Groups query", () => {
  it("reads every field it offers, and each example on the help card", () => {
    const terms = ["name:web", "id:ssh", "rules>1", "nodes:0", "used_by>=2", "node:db-1", "port:22", "remote:10.7.0.0/24", "protocol:udp", "direction:egress", "action:deny", "comment:mail", "version>2", "is:legacy", "sort:-rules,nodes,name,version"];
    for (const text of [...terms, ...GROUPS_QUERY_EXAMPLES.map((example) => example.query)]) {
      expect(compileQuery(text, groups).ok, text).toBe(true);
    }
    expect(errorOf(groups, "acton:deny")).toMatchObject({ code: "unknownField", params: { suggestion: "action" } });
    expect(errorOf(groups, "action:reject")).toMatchObject({ code: "unknownValue" });
    expect(errorOf(groups, "sort:port")).toMatchObject({ code: "unknownSort" });
  });

  it("finds the rules that name a port, whatever they do with it", () => {
    // egress-dns names every port on any protocol.
    expect(groupIds(run(groups, GROUPS, "port:22"))).toEqual(["ssh", "egress-dns", "legacy:homeserver"]);
    expect(groupIds(run(groups, GROUPS, "port:25 action:deny"))).toEqual(["monitoring"]);
    expect(groupIds(run(groups, GROUPS, "port:36712/udp"))).toEqual(["relay-hub", "egress-dns"]);
    expect(groupIds(run(groups, GROUPS, "port:36712/tcp -protocol:any"))).toEqual([]);
    expect(groupIds(run(groups, GROUPS, "port:31005-31008"))).toEqual(["relay-hub", "egress-dns"]);
  });

  it("counts and names the nodes that bind a group", () => {
    expect(groupIds(run(groups, GROUPS, "nodes:0"))).toEqual(["web", "egress-dns", "legacy:homeserver"]);
    expect(groupIds(run(groups, GROUPS, "nodes>=2 sort:-nodes"))).toEqual(["ssh", "relay-hub"]);
    expect(groupIds(run(groups, GROUPS, "node:db-1"))).toEqual(["ssh", "db-wg"]);
  });

  it("reads remotes by value and by the zone or group they name", () => {
    expect(groupIds(run(groups, GROUPS, "remote:wg"))).toEqual(["db-wg"]);
    expect(groupIds(run(groups, GROUPS, "remote:10.7.0.0/24"))).toEqual(["monitoring"]);
    expect(groupIds(run(groups, GROUPS, "is:legacy OR direction:egress"))).toEqual(["egress-dns", "legacy:homeserver"]);
  });

  it("opens the groups a query reaches inside of, and none for what it leaves out", () => {
    const reached = (text: string) => [...groupsReachedByQuery(text, run(groups, GROUPS, text), groups, ctx)];
    expect(reached("port:5432")).toEqual(["db-wg", "egress-dns"]);
    // The ssh group's own name answers the word, so its row says enough; the
    // homeserver baseline holds it only in a rule id (l-ssh), so it opens.
    expect(reached("ssh")).toEqual(["legacy:homeserver"]);
    expect(reached("postgres")).toEqual(["db-wg"]);
    // Kept through its name, web has no rule on 22, so it stays folded.
    expect(reached("name:web OR port:22")).toEqual(["ssh", "egress-dns", "legacy:homeserver"]);
    expect(reached("-port:22")).toEqual([]);
    expect(reached("nodes:0")).toEqual([]);
  });
});

// ── Zones ───────────────────────────────────────────────────────────────────

const zones = zonesQuerySchema(() => ({ nodes: INTENT }));
const zoneIds = (rows: readonly GuardZone[]) => rows.map((zone) => zone.id);

describe("the Zones query", () => {
  it("reads every field it offers, and each example on the help card", () => {
    for (const text of ["name:wg", "id:office", "interface:wg0", "iface:lo", "cidr:10.", "nodes>0", "trusted_by:0", "is:builtin", "sort:-nodes,name", ...ZONES_QUERY_EXAMPLES.map((example) => example.query)]) {
      expect(compileQuery(text, zones).ok, text).toBe(true);
    }
  });

  it("filters on what the Zones table shows", () => {
    expect(zoneIds(run(zones, ZONES, "-is:builtin"))).toEqual(["office", "lab"]);
    expect(zoneIds(run(zones, ZONES, "cidr:10."))).toEqual(["wireguard", "office"]);
    expect(zoneIds(run(zones, ZONES, "interface:wg0 OR interface:lo"))).toEqual(["loopback", "wireguard"]);
    expect(zoneIds(run(zones, ZONES, "concentrator"))).toEqual(["office"]);
  });

  it("counts bindings for the zones a binding can trust, and no count for loopback and public", () => {
    expect(zoneIds(run(zones, ZONES, "nodes:0"))).toEqual(["lab"]);
    expect(zoneIds(run(zones, ZONES, "sort:-nodes")).slice(0, 2)).toEqual(["wireguard", "office"]);
    expect(zoneIds(run(zones, ZONES, "sort:-nodes")).slice(-2)).toEqual(["loopback", "public"]);
  });
});
