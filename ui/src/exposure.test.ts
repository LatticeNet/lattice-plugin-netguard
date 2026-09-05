import { describe, expect, it } from "vitest";

import {
  allowsPreview,
  applyOrder,
  bindPlacement,
  compareExposure,
  computeExposure,
  draftRuleFor,
  findingsFor,
  formatSpans,
  indexInterfaces,
  isPublicCidr,
  matchesGroup,
  matchesZone,
  newestCollectedAt,
  parseAddress,
  ruleSentence,
  settleOrder,
  usedByNodes,
  zoneIndex,
  type ExposureContext,
} from "./exposure";
import type { GuardListener, GuardNode, GuardNodeReality, GuardRule, GuardZone, SecurityGroup } from "./netguardModel";
import type { PostureRow } from "./posture";

// ── fixtures ────────────────────────────────────────────────────────────────

const wg: GuardZone = { id: "wireguard", name: "wg", builtin: true, interfaces: ["wg0"], cidrs: ["10.7.0.0/24"] };
const office: GuardZone = { id: "office", name: "Office VPN", interfaces: [], cidrs: ["10.99.0.0/16"] };

function rule(over: Partial<GuardRule> & { id: string }): GuardRule {
  return { action: "allow", direction: "ingress", protocol: "tcp", ports: [], remote: { kind: "any" }, ...over };
}

const ssh: SecurityGroup = {
  id: "ssh",
  name: "ssh",
  version: 1,
  rules: [rule({ id: "ssh-any", ports: [{ from: 22, to: 22 }] })],
};
const relay: SecurityGroup = {
  id: "relay-hub",
  name: "relay-hub",
  version: 3,
  rules: [
    rule({ id: "bank", ports: [{ from: 31001, to: 31012 }] }),
    rule({ id: "reality", ports: [{ from: 32426, to: 32426 }] }),
  ],
};
const dbWg: SecurityGroup = {
  id: "db",
  name: "db",
  version: 1,
  rules: [rule({ id: "pg-wg", ports: [{ from: 5432, to: 5432 }], remote: { kind: "zone", zone_id: "wireguard" } })],
};

const ctx: ExposureContext = { groups: [ssh, relay, dbWg], zones: [wg, office], nodeNames: new Map([["n2", "sin-edge-02"]]) };

function intent(nodeId: string, groups: SecurityGroup[], over: Partial<GuardNode> = {}): GuardNode {
  return {
    node_id: nodeId,
    node_name: nodeId,
    source: "stored",
    binding: { node_id: nodeId, group_ids: groups.map((group) => group.id), zone_ids: ["wireguard"], managed: true, version: 1 },
    groups,
    zones: [wg],
    ...over,
  };
}

function row(nodeId: string, over: Partial<PostureRow> = {}): PostureRow {
  return {
    nodeId,
    nodeName: nodeId,
    coverage: "managed",
    snapshotStatus: "fresh",
    driftState: "in_sync",
    collectedAt: "2026-09-02T03:52:10Z",
    groupIds: [],
    zoneIds: [],
    ...over,
  };
}

function listener(port: number, address = "0.0.0.0", process = "sshd", protocol = "tcp"): GuardListener {
  return { protocol, address, port, process };
}

function reality(listeners: GuardListener[], over: Partial<GuardNodeReality> = {}): GuardNodeReality {
  return {
    node_id: "n1",
    collected_at: "2026-09-02T03:52:10Z",
    listeners,
    interfaces: [
      { name: "eth0", addresses: ["203.0.113.4/24"], up: true },
      { name: "wg0", addresses: ["10.7.0.5/24"], up: true },
    ],
    ...over,
  };
}

const managedNode = row("n1", { intent: intent("n1", [ssh, relay, dbWg]), groupIds: ["ssh", "relay-hub", "db"] });

// ── the six cases the table rests on ────────────────────────────────────────

describe("computeExposure", () => {
  it("does not count a loopback-only listener as exposed", () => {
    const result = computeExposure(managedNode, reality([listener(53, "127.0.0.53", "resolved"), listener(5433, "::1", "postgres")]), ctx);
    expect(result.open).toEqual([]);
    expect(result.confined).toEqual([]);
    expect(result.unexplained).toBe(0);
  });

  it("marks a 0.0.0.0 listener with no rule as open and unexplained where nothing is enforced", () => {
    const legacy = row("home", {
      coverage: "legacy",
      driftState: "unknown",
      intent: intent("home", [{ id: "home-legacy", name: "legacy baseline", version: 1, source: "legacy", node_id: "home", rules: [rule({ id: "l22", ports: [{ from: 22, to: 22 }] })] }], { source: "legacy" }),
    });
    const result = computeExposure(legacy, reality([listener(22), listener(5432, "0.0.0.0", "postgres")]), ctx);
    expect(formatSpans(result.open)).toBe("22, 5432");
    expect(result.open.map((span) => span.verdict)).toEqual(["allowed", "unexplained"]);
    expect(result.unexplained).toBe(1);
    expect(result.managedBy).toEqual({ kind: "legacy", names: ["legacy baseline"] });

    // The same socket on a node with no binding at all is red for the same reason.
    const unbound = computeExposure(row("mac", { coverage: "unbound", driftState: "unknown" }), reality([listener(8080, "::", "node")]), ctx);
    expect(unbound.open).toEqual([{ protocol: "tcp", from: 8080, to: 8080, processes: ["node"], verdict: "unexplained" }]);
    expect(unbound.managedBy).toEqual({ kind: "none" });
  });

  it("closes an uncovered listener by policy on a managed node whose table is live", () => {
    // Rendering this red would claim postgres is reachable when the default
    // drop is exactly what stops it.
    const result = computeExposure(managedNode, reality([listener(9100, "0.0.0.0", "node_exporter")]), ctx);
    expect(result.open).toEqual([]);
    expect(result.confined).toEqual([{ protocol: "tcp", from: 9100, to: 9100, processes: ["node_exporter"], scopes: ["the wg zone"] }]);
    // Without a trusted zone the honest label is the policy itself.
    const noZones = row("n3", { intent: intent("n3", [ssh], { binding: { node_id: "n3", group_ids: ["ssh"], zone_ids: [], managed: true, version: 1 } }) });
    expect(computeExposure(noZones, reality([listener(9100)]), ctx).confined[0]?.scopes).toEqual(["closed by policy"]);
  });

  it("lists a listener a public rule covers under managed, not as exposed", () => {
    const result = computeExposure(managedNode, reality([listener(22)]), ctx);
    expect(result.open).toEqual([{ protocol: "tcp", from: 22, to: 22, processes: ["sshd"], verdict: "allowed" }]);
    expect(result.unexplained).toBe(0);
    expect(result.managedBy).toEqual({ kind: "groups", names: ["ssh", "relay-hub", "db"] });
    expect(result.enforced).toBe(true);
  });

  it("confines a listener only a zone-scoped rule covers to that zone", () => {
    const result = computeExposure(managedNode, reality([listener(5432, "0.0.0.0", "postgres")]), ctx);
    expect(result.open).toEqual([]);
    expect(result.confined).toEqual([{ protocol: "tcp", from: 5432, to: 5432, processes: ["postgres"], scopes: ["the wg zone"] }]);
    // Bound to the wg address itself, it is confined whatever the rules say.
    const onWg = computeExposure(row("mac", { coverage: "unbound", driftState: "unknown" }), reality([listener(5432, "10.7.0.5", "postgres")]), ctx);
    expect(onWg.confined[0]?.scopes).toEqual(["the wg zone"]);
    expect(onWg.open).toEqual([]);
  });

  it("treats a private cidr as a scope and a public cidr as the internet", () => {
    const privateOnly = row("n4", { intent: intent("n4", [{ id: "g", name: "g", version: 1, rules: [rule({ id: "r", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "10.99.0.0/16" } })] }]) });
    expect(computeExposure(privateOnly, reality([listener(22)]), ctx).confined[0]?.scopes).toEqual(["10.99.0.0/16"]);
    const world = row("n5", { intent: intent("n5", [{ id: "g", name: "g", version: 1, rules: [rule({ id: "r", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "0.0.0.0/0" } })] }]) });
    expect(computeExposure(world, reality([listener(22)]), ctx).open[0]?.verdict).toBe("allowed");
    expect(isPublicCidr("203.0.113.0/24")).toBe(true);
    expect(isPublicCidr("fd00::/8")).toBe(false);
    expect(isPublicCidr("::/0")).toBe(true);
  });

  it("confines a port the node's knock table gates instead of calling it open", () => {
    // Nothing of Lattice's confines sshd on this node, but the knock table
    // does, and it drops the SYN before any guard table would see it.
    const unbound = row("home", { coverage: "unbound", driftState: "unknown" });
    const sockets = reality([listener(22), listener(3434, "0.0.0.0", "sshd"), listener(5432, "0.0.0.0", "postgres")]);
    const result = computeExposure(unbound, sockets, ctx, { ports: [22, 3434] });
    expect(formatSpans(result.open)).toBe("5432");
    expect(result.unexplained).toBe(1);
    expect(result.confined).toEqual([
      { protocol: "tcp", from: 22, to: 22, processes: ["sshd"], scopes: ["the SSH knock gate"] },
      { protocol: "tcp", from: 3434, to: 3434, processes: ["sshd"], scopes: ["the SSH knock gate"] },
    ]);

    // A public allow in the guard table does not reopen it: the gate runs first.
    const managed = computeExposure(managedNode, reality([listener(22)]), ctx, { ports: [22] });
    expect(managed.open).toEqual([]);
    expect(managed.confined[0]?.scopes).toEqual(["the SSH knock gate"]);

    // The gate is tcp only, and a port it does not list is judged as before.
    const udp = computeExposure(unbound, reality([listener(22, "0.0.0.0", "wg", "udp"), listener(23)]), ctx, { ports: [22] });
    expect(udp.open.map((span) => `${formatSpans([span])}:${span.verdict}`)).toEqual(["22/udp:unexplained", "23:unexplained"]);

    // Without the gate the same node is as red as it always was.
    expect(computeExposure(unbound, sockets, ctx).unexplained).toBe(3);
  });

  it("refuses to trust scoped rules once the node has drifted", () => {
    const drifted = row("n1", { ...managedNode, driftState: "drift" });
    const result = computeExposure(drifted, reality([listener(22), listener(5432, "0.0.0.0", "postgres")]), ctx);
    expect(result.enforced).toBe(false);
    expect(result.open.map((span) => `${span.from}:${span.verdict}`)).toEqual(["22:allowed", "5432:unexplained"]);
  });

  it("renders a missing snapshot as no evidence rather than nothing open", () => {
    const never = computeExposure(row("n9", { snapshotStatus: "unknown", driftState: "unknown", collectedAt: undefined }), undefined, ctx);
    expect(never.evidence).toBe("none");
    expect(never.open).toEqual([]);
    expect(never.unexplained).toBe(0);
    // A snapshot the server flagged stale is still classified, and says so.
    const stale = computeExposure(row("n8", { snapshotStatus: "stale", coverage: "unbound", driftState: "unknown", collectedAt: "2026-08-30T14:02:00Z" }), reality([listener(22)], { collected_at: "2026-08-30T14:02:00Z" }), ctx);
    expect(stale.evidence).toBe("stale");
    expect(stale.collectedAt).toBe("2026-08-30T14:02:00Z");
    expect(formatSpans(stale.open)).toBe("22");
  });

  it("folds consecutive ports with the same verdict into a range", () => {
    const bank = Array.from({ length: 12 }, (_, index) => listener(31001 + index, "0.0.0.0", "sing-box"));
    const result = computeExposure(managedNode, reality([listener(22), ...bank, listener(32426, "::", "sing-box"), listener(51820, "0.0.0.0", "wireguard", "udp")]), ctx);
    expect(formatSpans(result.open)).toBe("22, 31001-31012, 32426");
    expect(result.open[1]?.processes).toEqual(["sing-box"]);
    // 51820/udp has no rule on a live table: closed, and marked as UDP.
    expect(formatSpans(result.confined)).toBe("51820/udp");
  });

  it("merges one port bound on several addresses into the most exposed entry", () => {
    const result = computeExposure(row("mac", { coverage: "unbound", driftState: "unknown" }), reality([listener(53, "127.0.0.1", "dnsmasq"), listener(53, "10.7.0.5", "dnsmasq"), listener(53, "0.0.0.0", "dnsmasq")]), ctx);
    expect(result.open).toHaveLength(1);
    expect(result.open[0]?.verdict).toBe("unexplained");
    expect(result.confined).toEqual([]);
  });
});

// ── where a bind puts a socket: the legend-sg shapes ────────────────────────

/** The tailscale zone as the fleet declares it: interface only, no cidrs. */
const tailscale: GuardZone = { id: "tailscale", name: "tailscale", interfaces: ["tailscale0"] };
/** A zone that claims its peers by cidr instead, the way a wg zone lists its peers. */
const wgPeers: GuardZone = { id: "wg-peers", name: "wg peers", interfaces: [], cidrs: ["10.7.0.0/24", "fd7a:115c:a1e0::/48"] };
const legendZones = zoneIndex([tailscale, wgPeers, office]);
const legendInterfaces = indexInterfaces([
  { name: "eth0", addresses: ["2a14:7dc0:102:10a5::2f/48", "77.93.91.41/24", "fe80::be24:11ff:fe19:479a/64"], up: true },
  { name: "lo", addresses: ["127.0.0.1/8", "::1/128"], up: true },
  { name: "tailscale0", addresses: ["100.86.92.48/32", "fd7a:115c:a1e0::cb39:5c30/128", "fe80::b559:cb32:1892:3dfb/64"], up: true },
]);
const legendNode = row("legend-sg", {
  coverage: "observe_only",
  driftState: "unknown",
  intent: intent("legend-sg", [ssh], { binding: { node_id: "legend-sg", group_ids: ["ssh"], zone_ids: ["tailscale"], managed: false, version: 1 }, zones: [tailscale] }),
});
const legendCtx: ExposureContext = { ...ctx, zones: [tailscale, wgPeers, office] };

describe("bindPlacement", () => {
  it("places a loopback bind as local, whatever the rules say", () => {
    for (const address of ["127.0.0.1", "127.0.0.53", "::1"]) {
      const placement = bindPlacement(listener(8080, address, "sing-box"), legendZones, legendInterfaces);
      expect(placement.kind, address).toBe("local");
      expect(placement.label).toBe("local only");
      expect(placement.detail).toContain("reachable only from the node itself");
    }
  });

  it("places a bind on a zone interface address, or inside a zone's cidrs, in that zone", () => {
    // 100.86.92.48 is tailscale0's own address; the zone is declared by interface.
    const v4 = bindPlacement(listener(43492, "100.86.92.48", "tailscaled"), legendZones, legendInterfaces);
    expect(v4).toMatchObject({ kind: "zone", zoneId: "tailscale", label: "tailscale only" });
    expect(v4.detail).toContain("on tailscale0");
    // The v6 address is on tailscale0 too, and the interface match wins over the cidr zone.
    const v6 = bindPlacement(listener(42489, "fd7a:115c:a1e0::cb39:5c30", "tailscaled"), legendZones, legendInterfaces);
    expect(v6).toMatchObject({ kind: "zone", zoneId: "tailscale" });
    // An address no reported interface owns still lands in the zone whose cidrs contain it.
    const peer = bindPlacement(listener(5432, "10.7.0.9", "postgres"), legendZones, []);
    expect(peer).toMatchObject({ kind: "zone", zoneId: "wg-peers", label: "wg peers only" });
  });

  it("keeps the any-address and a public interface address public", () => {
    expect(bindPlacement(listener(22, "0.0.0.0"), legendZones, legendInterfaces)).toMatchObject({ kind: "public", label: "public" });
    expect(bindPlacement(listener(22, "::"), legendZones, legendInterfaces).kind).toBe("public");
    expect(bindPlacement(listener(22, "*"), legendZones, legendInterfaces).kind).toBe("public");
    expect(bindPlacement(listener(443, "77.93.91.41", "nginx"), legendZones, legendInterfaces)).toMatchObject({ kind: "public" });
  });

  it("leaves a listener whose bind address is not in the report as unknown rather than guessing", () => {
    const missing: GuardListener = { protocol: "tcp", port: 9000, process: "node" };
    expect(bindPlacement(missing, legendZones, legendInterfaces)).toMatchObject({ kind: "unknown", label: "bind not reported" });
    expect(bindPlacement({ ...missing, address: "  " }, legendZones, legendInterfaces).kind).toBe("unknown");
  });
});

describe("computeExposure on legend-sg's sockets", () => {
  const sockets = [
    listener(22, "0.0.0.0"),
    listener(22, "::"),
    listener(8080, "127.0.0.1", "sing-box"),
    listener(9090, "127.0.0.1", "sing-box"),
    listener(17891, "::", "sing-box"),
    listener(42489, "fd7a:115c:a1e0::cb39:5c30", "tailscaled"),
    listener(43492, "100.86.92.48", "tailscaled"),
    listener(41641, "0.0.0.0", "tailscaled", "udp"),
    listener(41641, "::", "tailscaled", "udp"),
  ];
  const snapshot: GuardNodeReality = {
    node_id: "legend-sg",
    collected_at: "2026-09-05T11:16:35Z",
    listeners: sockets,
    interfaces: [
      { name: "eth0", addresses: ["77.93.91.41/24"], up: true },
      { name: "lo", addresses: ["127.0.0.1/8", "::1/128"], up: true },
      { name: "tailscale0", addresses: ["100.86.92.48/32", "fd7a:115c:a1e0::cb39:5c30/128"], up: true },
    ],
  };

  it("confines the tailscale-bound sockets to their zone as bind chips and drops the loopback ones", () => {
    const result = computeExposure(legendNode, snapshot, legendCtx);
    expect(formatSpans(result.open)).toBe("22, 17891, 41641/udp");
    expect(result.open.map((span) => span.verdict)).toEqual(["allowed", "unexplained", "unexplained"]);
    expect(result.confined).toEqual([
      { protocol: "tcp", from: 42489, to: 42489, processes: ["tailscaled"], scopes: ["the tailscale zone"], bindZone: "tailscale" },
      { protocol: "tcp", from: 43492, to: 43492, processes: ["tailscaled"], scopes: ["the tailscale zone"], bindZone: "tailscale" },
    ]);
    // 8080 and 9090 are the node talking to itself: not open, not confined, not counted.
    expect(result.unexplained).toBe(2);
    expect(findingsFor(legendNode, result, legendCtx).map((finding) => finding.span.from)).toEqual([17891, 41641]);
  });

  it("lists a socket with no bind address as unknown, never as open or as a finding", () => {
    const blind: GuardListener = { protocol: "tcp", port: 9000, process: "node" };
    const result = computeExposure(legendNode, { ...snapshot, listeners: [blind, listener(22, "0.0.0.0")] }, legendCtx);
    expect(result.open).toEqual([
      { protocol: "tcp", from: 22, to: 22, processes: ["sshd"], verdict: "allowed" },
      { protocol: "tcp", from: 9000, to: 9000, processes: ["node"], verdict: "unknown" },
    ]);
    expect(result.unexplained).toBe(0);
    expect(findingsFor(legendNode, result, legendCtx)).toEqual([]);
  });

  it("gives up the chip form when one port is bound by zone address and by a rule-scoped public bind", () => {
    const rules = [rule({ id: "pg-wg", ports: [{ from: 5432, to: 5432 }], remote: { kind: "zone", zone_id: "office" } })];
    const node = row("mixed", { coverage: "legacy", driftState: "unknown", intent: intent("mixed", [{ id: "l", name: "legacy", version: 1, source: "legacy", node_id: "mixed", rules }], { source: "legacy", zones: [tailscale] }) });
    const result = computeExposure(node, { ...snapshot, listeners: [listener(5432, "100.86.92.48", "postgres"), listener(5432, "0.0.0.0", "postgres")] }, legendCtx);
    expect(result.open).toEqual([]);
    expect(result.confined).toHaveLength(1);
    expect(result.confined[0]!.scopes).toEqual(["the tailscale zone", "the Office VPN zone"]);
    expect(result.confined[0]!.bindZone).toBeUndefined();
  });
});

describe("parseAddress", () => {
  it("reads IPv4, IPv6, mapped and bracketed forms", () => {
    expect(parseAddress("0.0.0.0")?.n).toBe(0n);
    expect(parseAddress("::")?.n).toBe(0n);
    expect(parseAddress("[::1]")?.n).toBe(1n);
    expect(parseAddress("::ffff:10.0.0.1")?.v).toBe(6);
    expect(parseAddress("fe80::1%eth0")?.v).toBe(6);
    expect(parseAddress("*")).toBeUndefined();
    expect(parseAddress("")).toBeUndefined();
    expect(parseAddress("300.1.1.1")).toBeUndefined();
    expect(parseAddress("1:2:3")).toBeUndefined();
  });
});

// ── the Groups and Zones tabs ───────────────────────────────────────────────

describe("allowsPreview and ruleSentence", () => {
  it("merges the sources of one service into a sentence", () => {
    const rules = [
      rule({ id: "a", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "10.7.0.0/24" } }),
      rule({ id: "b", ports: [{ from: 22, to: 22 }], remote: { kind: "zone", zone_id: "wireguard" } }),
      rule({ id: "c", ports: [{ from: 443, to: 443 }] }),
      rule({ id: "d", protocol: "any", remote: { kind: "zone", zone_id: "office" } }),
      rule({ id: "e", action: "deny", ports: [{ from: 25, to: 25 }] }),
      rule({ id: "f", disabled: true, ports: [{ from: 80, to: 80 }] }),
    ];
    expect(allowsPreview(rules, ctx)).toEqual([
      "TCP 22 from 10.7.0.0/24 and the wg zone",
      "TCP 443 from anywhere",
      "everything from the Office VPN zone",
    ]);
    expect(ruleSentence(rules[4]!, ctx)).toBe("denies TCP 25 from anywhere");
    expect(ruleSentence(rule({ id: "g", direction: "egress", ports: [{ from: 443, to: 443 }] }), ctx)).toBe("allows TCP 443 to anywhere");
    expect(ruleSentence(rule({ id: "h", protocol: "udp", remote: { kind: "node", node_id: "n2" } }), ctx)).toBe("allows all UDP from node sin-edge-02");
  });

  it("counts the nodes a group or zone is bound to", () => {
    const nodes = [intent("a", [ssh]), intent("b", [ssh, relay]), intent("c", [], { binding: { node_id: "c", group_ids: [], zone_ids: [], managed: false, version: 1 } })];
    expect(usedByNodes(nodes, "group_ids", "ssh")).toBe(2);
    expect(usedByNodes(nodes, "group_ids", "relay-hub")).toBe(1);
    expect(usedByNodes(nodes, "zone_ids", "wireguard")).toBe(2);
    expect(usedByNodes(nodes, "zone_ids", "office")).toBe(0);
  });
});

// ── findings under the table ────────────────────────────────────────────────

describe("findingsFor", () => {
  it("writes one finding per unexplained span, in the node's own terms", () => {
    const observe = row("obs", { coverage: "observe_only", driftState: "unknown", intent: intent("obs", [ssh], { binding: { node_id: "obs", group_ids: ["ssh"], zone_ids: [], managed: false, version: 1 } }) });
    const exposure = computeExposure(observe, reality([listener(22), listener(5432, "0.0.0.0", "postgres"), listener(8080, "0.0.0.0", "nginx")]), ctx);
    const findings = findingsFor(observe, exposure, ctx);
    expect(findings.map((finding) => finding.key)).toEqual(["obs:tcp:5432-5432", "obs:tcp:8080-8080"]);
    expect(findings[0]?.sentence).toBe("5432 (postgres) is open to the internet and no rule allows it.");
    expect(findings[0]?.hint).toContain("enforces nothing on it");
    expect(findings[0]?.hint).toContain("from the wg zone only");
    expect(findings[0]?.zoneId).toBe("wireguard");
    const draft = draftRuleFor(findings[0]!);
    expect(draft).toMatchObject({ action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 5432, to: 5432 }], remote: { kind: "zone", zone_id: "wireguard" } });
    expect(draft.comment).toBe("postgres on obs");
  });

  it("falls back to a cidr when no overlay zone exists to name", () => {
    const bare: ExposureContext = { groups: [], zones: [] };
    const unbound = row("mac", { coverage: "unbound", driftState: "unknown" });
    const findings = findingsFor(unbound, computeExposure(unbound, reality([listener(8080, "0.0.0.0", "")]), bare), bare);
    expect(findings[0]?.sentence).toBe("8080 is open to the internet and no rule allows it.");
    expect(findings[0]?.hint).toContain("no binding");
    expect(findings[0]?.hint).toContain("from the cidr that needs it only");
    expect(draftRuleFor(findings[0]!).remote).toEqual({ kind: "any" });
  });
});

describe("ordering", () => {
  it("opens on unexplained ports, then drift, then name", () => {
    const quiet = { row: row("b-quiet"), exposure: computeExposure(row("b-quiet"), reality([]), ctx) };
    const drifted = { row: row("c-drift", { driftState: "drift" }), exposure: computeExposure(row("c-drift", { driftState: "drift" }), reality([]), ctx) };
    const loud = { row: row("a-loud", { coverage: "unbound", driftState: "unknown" }), exposure: computeExposure(row("a-loud", { coverage: "unbound", driftState: "unknown" }), reality([listener(8080)]), ctx) };
    const sorted = [quiet, drifted, loud].sort((a, b) => compareExposure(a, b, "attention"));
    expect(sorted.map((item) => item.row.nodeId)).toEqual(["a-loud", "c-drift", "b-quiet"]);
    expect([quiet, loud].sort((a, b) => compareExposure(a, b, "name")).map((item) => item.row.nodeId)).toEqual(["a-loud", "b-quiet"]);
  });

  it("finds the newest snapshot for the proof line", () => {
    expect(newestCollectedAt([row("a", { collectedAt: "2026-09-02T03:50:00Z" }), row("b", { collectedAt: "2026-09-02T03:52:10Z" }), row("c", { collectedAt: undefined })])).toBe("2026-09-02T03:52:10Z");
    expect(newestCollectedAt([])).toBeUndefined();
  });
});

describe("settled order", () => {
  // The per-node snapshot reads stream in after the list paints, and every
  // node's unexplained count is 0 until its own read returns. A live sort
  // moves the row under the pointer for the first seconds after load; the
  // page settles the order at known points and reads through the index.
  // Three unbound nodes with no drift verdict, so the default order can only
  // come from unexplained ports and then the name.
  const unbound = { coverage: "unbound", driftState: "unknown" } as const;
  const quiet = { row: row("b-quiet", unbound), exposure: computeExposure(row("b-quiet", unbound), reality([]), ctx) };
  const pending = { row: row("c-pending", unbound), exposure: computeExposure(row("c-pending", unbound), undefined, ctx) };
  const loud = { row: row("a-loud", unbound), exposure: computeExposure(row("a-loud", unbound), reality([listener(8080)]), ctx) };

  it("holds a row where it was settled even after its detail arrives", () => {
    const beforeDetails = settleOrder([quiet, pending, loud], "attention", "asc");
    expect([...beforeDetails.keys()]).toEqual(["a-loud", "b-quiet", "c-pending"]);

    // c-pending's snapshot lands and it turns out to be the loudest node.
    const landed = { ...pending, exposure: computeExposure(pending.row, reality([listener(5432), listener(8080)]), ctx) };
    expect(landed.exposure.unexplained).toBeGreaterThan(loud.exposure.unexplained);
    expect(applyOrder([quiet, landed, loud], beforeDetails).map((view) => view.row.nodeId)).toEqual(["a-loud", "b-quiet", "c-pending"]);

    // Once the fan-in completes the page settles again and it moves up.
    const afterDetails = settleOrder([quiet, landed, loud], "attention", "asc");
    expect(applyOrder([quiet, landed, loud], afterDetails).map((view) => view.row.nodeId)).toEqual(["c-pending", "a-loud", "b-quiet"]);
  });

  it("keeps a filtered subset in settled order and appends nodes the index has not seen by name", () => {
    const order = settleOrder([quiet, pending, loud], "name", "desc");
    expect([...order.keys()]).toEqual(["c-pending", "b-quiet", "a-loud"]);
    expect(applyOrder([loud, quiet], order).map((view) => view.row.nodeId)).toEqual(["b-quiet", "a-loud"]);
    const newcomer = { row: row("d-new"), exposure: computeExposure(row("d-new"), reality([]), ctx) };
    const another = { row: row("aa-new"), exposure: computeExposure(row("aa-new"), reality([]), ctx) };
    expect(applyOrder([newcomer, loud, another, quiet], order).map((view) => view.row.nodeId)).toEqual(["b-quiet", "a-loud", "aa-new", "d-new"]);
  });
});

describe("search across the lenses", () => {
  const groupWithComment: SecurityGroup = { ...relay, rules: [rule({ id: "hy2", protocol: "udp", ports: [{ from: 36712, to: 36712 }], comment: "Hysteria2" })] };

  it("matches a group by name, id, rule sentence or comment and says when the hit is in a rule", () => {
    expect(matchesGroup(ssh, ctx, "ssh")).toEqual({ hit: true, inRules: false });
    expect(matchesGroup(dbWg, ctx, "5432")).toEqual({ hit: true, inRules: true });
    expect(matchesGroup(dbWg, ctx, "wg")).toEqual({ hit: true, inRules: true });
    expect(matchesGroup(groupWithComment, ctx, "hysteria")).toEqual({ hit: true, inRules: true });
    expect(matchesGroup(ssh, ctx, "postgres")).toEqual({ hit: false, inRules: false });
  });

  it("matches a zone by name, id, interface, cidr or description", () => {
    expect(matchesZone(wg, "wg0")).toBe(true);
    expect(matchesZone(wg, "10.7")).toBe(true);
    expect(matchesZone(office, "office vpn")).toBe(true);
    expect(matchesZone({ ...office, description: "The office concentrator" }, "concentrator")).toBe(true);
    expect(matchesZone(wg, "tailscale")).toBe(false);
  });
});
