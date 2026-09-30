import { describe, expect, it } from "vitest";

import { adoptPreview } from "./adopt";
import type { ExposureContext, KnockGate, NodeExposure, OpenSpan } from "./exposure";
import type { GuardNode, GuardNodeReality, GuardRule, GuardZone } from "./netguardModel";
import type { DetailState, ExposureRowView } from "./overview";
import type { PostureRow } from "./posture";

const lan: GuardZone = { id: "office", name: "Office VPN", cidrs: ["10.99.0.0/16"] };
const ctx: ExposureContext = { groups: [], zones: [lan] };

const baseline: GuardNode = {
  node_id: "cd-homeserver",
  node_name: "[cd]-homeserver",
  source: "legacy",
  binding: { node_id: "cd-homeserver", group_ids: ["legacy:cd-homeserver"], zone_ids: ["office"], managed: false, version: 1 },
  groups: [
    {
      id: "legacy:cd-homeserver",
      name: "cd-homeserver baseline",
      version: 1,
      source: "legacy",
      rules: [
        { id: "l-ssh", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "any" } },
        { id: "l-web", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }], remote: { kind: "any" }, comment: "nginx" },
        { id: "l-old", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 8080, to: 8080 }], remote: { kind: "any" }, disabled: true },
      ],
    },
  ],
  zones: [],
};

function span(from: number, verdict: OpenSpan["verdict"], processes: string[]): OpenSpan {
  return { protocol: "tcp", from, to: from, processes, verdict };
}

function view(over: Partial<PostureRow> = {}, detail: DetailState = "loaded"): ExposureRowView {
  const row: PostureRow = {
    nodeId: "cd-homeserver",
    nodeName: "[cd]-homeserver",
    coverage: "legacy",
    snapshotStatus: "fresh",
    driftState: "unknown",
    groupIds: [],
    zoneIds: ["office"],
    intent: baseline,
    ...over,
  };
  const exposure: NodeExposure = {
    nodeId: row.nodeId,
    evidence: row.snapshotStatus === "stale" ? "stale" : row.snapshotStatus === "unknown" ? "none" : "fresh",
    open: [span(22, "allowed", ["sshd"]), span(80, "allowed", ["nginx"]), span(5432, "unexplained", ["postgres"]), span(9000, "unknown", [])],
    confined: [],
    unexplained: 1,
    managedBy: { kind: "legacy", names: ["cd-homeserver baseline"] },
    enforced: false,
  };
  return { row, exposure, detail };
}

describe("the adopt preview", () => {
  it("lists the baseline's rules, the zones, and the open ports the first apply closes", () => {
    const preview = adoptPreview(view(), ctx);
    expect(preview.groupNames).toEqual(["cd-homeserver baseline"]);
    expect(preview.rules.map((rule) => [rule.sentence, rule.disabled])).toEqual([
      ["allows TCP 22 from anywhere", false],
      ["allows TCP 80, 443 from anywhere", false],
      ["allows TCP 8080 from anywhere", true],
    ]);
    expect(preview.rules[1]!.comment).toBe("nginx");
    expect(preview.zones).toEqual(["Office VPN"]);
    expect(preview.evidence).toBe("fresh");
    expect(preview.dropped).toEqual(["5432/tcp postgres"]);
    expect(preview.uncertain).toEqual(["9000/tcp"]);
  });

  it("claims nothing about open ports it has not read", () => {
    expect(adoptPreview(view({ snapshotStatus: "stale" }), ctx)).toMatchObject({ evidence: "stale", dropped: [], uncertain: [] });
    expect(adoptPreview(view({ snapshotStatus: "unknown" }), ctx)).toMatchObject({ evidence: "none", dropped: [] });
    expect(adoptPreview(view({}, "pending"), ctx)).toMatchObject({ evidence: "reading", dropped: [] });
  });

  it("prefers the zones the intent resolved", () => {
    const resolved = view({ intent: { ...baseline, zones: [{ id: "tailscale", name: "tailscale" }] } });
    expect(adoptPreview(resolved, ctx).zones).toEqual(["tailscale"]);
  });
});

describe("ports reachable today by another path", () => {
  const tailscale: GuardZone = { id: "tailscale", name: "tailscale", interfaces: ["tailscale0"], cidrs: ["100.64.0.0/10"] };
  const zoned: ExposureContext = { groups: [], zones: [lan, tailscale] };
  const reality: GuardNodeReality = {
    node_id: "cd-homeserver",
    collected_at: "2026-09-30T09:00:00Z",
    interfaces: [
      { name: "eth0", addresses: ["203.0.113.5/24"] },
      { name: "tailscale0", addresses: ["100.101.1.2/32"] },
    ],
    listeners: [
      { protocol: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
      { protocol: "tcp", address: "::", port: 22, process: "sshd" },
      { protocol: "tcp", address: "100.101.1.2", port: 8443, process: "lattice-console" },
      { protocol: "tcp", address: "127.0.0.1", port: 5432, process: "postgres" },
    ],
  };
  const knock: KnockGate = { ports: [22] };

  function withRules(rules: GuardRule[], zoneIds = ["office"]): ExposureRowView {
    const intent: GuardNode = {
      ...baseline,
      binding: { ...baseline.binding!, zone_ids: zoneIds },
      groups: [{ ...baseline.groups![0]!, rules }],
    };
    return view({ intent, zoneIds });
  }
  const web: GuardRule = { id: "l-web", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 80, to: 80 }], remote: { kind: "any" } };

  it("names a knock-gated SSH port the new table has no rule for, which the first apply closes to knockers", () => {
    const preview = adoptPreview(withRules([web]), zoned, { reality, knock });
    const ssh = preview.cut.find((item) => item.port === "22/tcp sshd");
    expect(ssh?.reason).toBe(
      "Gated by the SSH knock table today. No rule accepts it, so a knock no longer gets through. Only the trusted Office VPN zone still reaches it.",
    );
  });

  it("keeps a knock-gated port the new table accepts from the internet", () => {
    const ssh: GuardRule = { id: "l-ssh", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "any" } };
    const fromPublic: GuardRule = { ...ssh, id: "l-ssh-zone", remote: { kind: "zone", zone_id: "public" } };
    expect(adoptPreview(withRules([web, ssh]), zoned, { reality, knock }).cut.map((item) => item.port)).not.toContain("22/tcp sshd");
    expect(adoptPreview(withRules([web, fromPublic]), zoned, { reality, knock }).cut.map((item) => item.port)).not.toContain("22/tcp sshd");
  });

  it("says a knock-gated port accepted only from a narrower source loses every other knocker", () => {
    const mgmt: GuardRule = { id: "l-ssh", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "10.7.0.0/24" } };
    const ssh = adoptPreview(withRules([web, mgmt], []), zoned, { reality, knock }).cut.find((item) => item.port === "22/tcp sshd");
    expect(ssh?.reason).toBe("Gated by the SSH knock table today. The new table accepts it only from 10.7.0.0/24, so a knock from anywhere else no longer gets through.");
  });

  it("counts only every-address as internet-wide: a public /32 admits one knocker", () => {
    const one: GuardRule = { id: "l-ssh", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "203.0.113.7/32" } };
    const ssh = adoptPreview(withRules([web, one], []), zoned, { reality, knock }).cut.find((item) => item.port === "22/tcp sshd");
    // Compiles to `ip saddr 203.0.113.7/32 tcp dport 22 accept` ahead of `counter drop`.
    expect(ssh?.reason).toBe("Gated by the SSH knock table today. The new table accepts it only from 203.0.113.7/32, so a knock from anywhere else no longer gets through.");
  });

  it("judges a /0 prefix per address family", () => {
    const v4: GuardRule = { id: "any4", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "0.0.0.0/0" } };
    const v6: GuardRule = { ...v4, id: "any6", remote: { kind: "cidr", cidr: "::/0" } };
    // 22 is bound on 0.0.0.0 and on ::; `ip saddr 0.0.0.0/0` never matches the IPv6 socket's knockers.
    const onlyV4 = adoptPreview(withRules([web, v4], []), zoned, { reality, knock }).cut.find((item) => item.port === "22/tcp sshd");
    expect(onlyV4?.reason).toContain("accepts it only from 0.0.0.0/0");
    expect(adoptPreview(withRules([web, v4, v6], []), zoned, { reality, knock }).cut.map((item) => item.port)).not.toContain("22/tcp sshd");
  });

  it("takes a wildcard bind as dual-stack: kept only when both families are accepted", () => {
    const v4: GuardRule = { id: "any4", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "0.0.0.0/0" } };
    const v6: GuardRule = { ...v4, id: "any6", remote: { kind: "cidr", cidr: "::/0" } };
    const bound = (address: string): GuardNodeReality => ({ ...reality, listeners: [{ protocol: "tcp", address, port: 22, process: "sshd" }] });
    const cut = (address: string, rules: GuardRule[]) => adoptPreview(withRules([web, ...rules], []), zoned, { reality: bound(address), knock }).cut;
    // A Go listener on ":22" binds :: and takes IPv4 too, so ::/0 alone cuts the IPv4 knockers.
    expect(cut("::", [v6])[0]?.reason).toContain("accepts it only from ::/0");
    // `*` is how older iproute2 prints that bind.
    expect(cut("*", [v4])[0]?.reason).toContain("accepts it only from 0.0.0.0/0");
    expect(cut("::", [v4, v6])).toEqual([]);
    expect(cut("*", [v4, v6])).toEqual([]);
    // A specific IPv6 address answers on IPv6 only.
    expect(cut("2001:db8:1::a", [v6])).toEqual([]);
  });

  it("does not let the WireGuard fast path, IPv4 peers only, keep an IPv6 socket", () => {
    const wg: GuardZone = { id: "wireguard", name: "wireguard", interfaces: ["wg0"], cidrs: ["10.66.0.0/24"] };
    const wgCtx: ExposureContext = { groups: [], zones: [lan, wg] };
    const wgReality: GuardNodeReality = {
      node_id: "cd-homeserver",
      collected_at: "2026-09-30T09:00:00Z",
      interfaces: [{ name: "wg0", addresses: ["10.66.0.5/24", "fd00:66::5/64"] }],
      listeners: [
        { protocol: "tcp", address: "10.66.0.5", port: 9100, process: "node_exporter" },
        { protocol: "tcp", address: "fd00:66::5", port: 9101, process: "exporter6" },
      ],
    };
    const fromWg: GuardRule = { id: "wg", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 9100, to: 9101 }], remote: { kind: "zone", zone_id: "wireguard" } };
    const cut = adoptPreview(withRules([fromWg]), wgCtx, { reality: wgReality }).cut;
    // `ip saddr @wg_peers4 tcp dport { 9100, 9101 } accept`: the IPv4 socket keeps its path, the IPv6 one does not.
    expect(cut).toEqual([
      {
        port: "9101/tcp exporter6",
        reason: "Bound to an IPv6 wireguard address, reachable through that zone today. The new table accepts the wireguard zone for IPv4 sources only, so traffic to this address is dropped.",
      },
    ]);
    // Trusting the zone accepts wg0 by interface, both families.
    expect(adoptPreview(withRules([fromWg], ["office", "wireguard"]), wgCtx, { reality: wgReality }).cut).toEqual([]);
  });

  it("folds a bank of knock-gated ports with one reason into a range", () => {
    const bank: GuardNodeReality = {
      ...reality,
      listeners: [2222, 2223, 2224].map((port) => ({ protocol: "tcp", address: "0.0.0.0", port, process: "sshd" })),
    };
    const cut = adoptPreview(withRules([web], []), zoned, { reality: bank, knock: { ports: [2222, 2223, 2224] } }).cut;
    expect(cut.map((item) => item.port)).toEqual(["2222-2224/tcp sshd"]);
  });

  it("names a socket bound to a zone this node does not trust", () => {
    const preview = adoptPreview(withRules([web]), zoned, { reality, knock });
    expect(preview.cut).toContainEqual({
      port: "8443/tcp lattice-console",
      reason: "Bound to a tailscale address, reachable through that zone today. This node does not trust the tailscale zone and no rule accepts the port from it.",
    });
    // Loopback is never listed, and nothing is listed twice.
    expect(preview.cut.map((item) => item.port)).toEqual(["22/tcp sshd", "8443/tcp lattice-console"]);
  });

  it("keeps a zone-bound socket once the zone is trusted or a rule reaches it from that zone or from anywhere", () => {
    const ports = (v: ExposureRowView) => adoptPreview(v, zoned, { reality }).cut.map((item) => item.port);
    const console = (remote: GuardRule["remote"]): GuardRule => ({ id: "c", action: "allow", direction: "ingress", protocol: "tcp", ports: [{ from: 8443, to: 8443 }], remote });
    expect(ports(withRules([web], ["office", "tailscale"]))).toEqual([]);
    expect(ports(withRules([web, console({ kind: "zone", zone_id: "tailscale" })]))).toEqual([]);
    expect(ports(withRules([web, console({ kind: "any" })]))).toEqual([]);
    // An allow from the public zone is `iifname <public>`: tailscale0 traffic never meets it.
    const publicOnly = adoptPreview(withRules([web, console({ kind: "zone", zone_id: "public" })]), zoned, { reality }).cut;
    expect(publicOnly[0]?.reason).toContain("accepts the port only from the public zone");
  });

  it("lists nothing it has not read, and nothing without a snapshot", () => {
    expect(adoptPreview(view({ snapshotStatus: "stale" }), zoned, { reality, knock }).cut).toEqual([]);
    expect(adoptPreview(withRules([web]), zoned, {}).cut).toEqual([]);
  });

  it("prints a udp port once, not as 51820/udp/udp", () => {
    const udp = view();
    udp.exposure.open = [{ protocol: "udp", from: 51820, to: 51820, processes: [], verdict: "unexplained" }];
    expect(adoptPreview(udp, ctx).dropped).toEqual(["51820/udp"]);
  });
});
