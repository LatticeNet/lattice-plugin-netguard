import { describe, expect, it } from "vitest";

import { adoptPreview } from "./adopt";
import type { ExposureContext, NodeExposure, OpenSpan } from "./exposure";
import type { GuardNode, GuardZone } from "./netguardModel";
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
