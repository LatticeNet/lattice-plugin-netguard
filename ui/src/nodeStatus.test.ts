import { describe, expect, it } from "vitest";

import { KNOCK_SCOPE, type ConfinedSpan, type NodeExposure, type OpenSpan } from "./exposure";
import { idAddsInformation } from "./identity";
import { confinedPhrase, managedCell, nodeStatus, orderedOpen } from "./nodeStatus";
import { needsAttention, type DetailState, type ExposureRowView } from "./overview";
import type { PostureRow } from "./posture";

function row(over: Partial<PostureRow> = {}): PostureRow {
  return {
    nodeId: "cd-build-1",
    nodeName: "[cd]-build-1",
    coverage: "managed",
    snapshotStatus: "fresh",
    driftState: "in_sync",
    collectedAt: "2026-10-04T15:52:00Z",
    appliedTableSha: "a",
    managedSha: "a",
    lastAppliedAt: "2026-10-03T14:53:00Z",
    groupIds: ["ssh"],
    zoneIds: [],
    ...over,
  };
}

function exposure(over: Partial<NodeExposure> = {}): NodeExposure {
  return {
    nodeId: "cd-build-1",
    evidence: "fresh",
    collectedAt: "2026-10-04T15:52:00Z",
    open: [],
    confined: [],
    unexplained: 0,
    rulesRead: true,
    managedBy: { kind: "groups", names: ["ssh"] },
    enforced: true,
    ...over,
  };
}

function view(rowOver: Partial<PostureRow> = {}, exposureOver: Partial<NodeExposure> = {}, detail: DetailState = "loaded"): ExposureRowView {
  return { row: row(rowOver), exposure: exposure(exposureOver), detail };
}

function span(from: number, verdict: OpenSpan["verdict"], protocol: OpenSpan["protocol"] = "tcp"): OpenSpan {
  return { protocol, from, to: from, processes: [], verdict };
}

describe("nodeStatus", () => {
  it("calls a managed node whose live table matches what Lattice applied enforced", () => {
    expect(nodeStatus(view(), true)).toMatchObject({ key: "enforced", tone: "healthy", label: "Enforced" });
  });

  it("puts drift ahead of every other fact on the row", () => {
    const status = nodeStatus(view({ driftState: "drift", lastError: "nft: exit 1", snapshotStatus: "stale" }, { unexplained: 2 }), true);
    expect(status).toMatchObject({ key: "drift", tone: "error", label: "Drifted" });
  });

  it("names a failed apply with the server's own reason in the title", () => {
    const status = nodeStatus(view({ lastError: "nft: exit 1" }), true);
    expect(status).toMatchObject({ key: "apply-failed", tone: "error", label: "Apply failed" });
    expect(status.title).toContain("nft: exit 1");
  });

  it("counts ports no rule allows, in the singular and the plural", () => {
    expect(nodeStatus(view({ coverage: "observe_only", driftState: "unknown" }, { unexplained: 1, enforced: false }), true).label).toBe("1 port, no rule");
    const two = nodeStatus(view({ coverage: "observe_only", driftState: "unknown" }, { unexplained: 2, enforced: false }), true);
    expect(two).toMatchObject({ key: "unexplained", tone: "error", label: "2 ports, no rule" });
    expect(two.title).toContain("Nothing on this node enforces its rules.");
  });

  it("never judges ports from a stale or unread snapshot", () => {
    const stale = nodeStatus(view({ snapshotStatus: "stale", collectedAt: "2026-10-01T15:33:00Z" }, { evidence: "stale", unexplained: 3 }), true);
    expect(stale).toMatchObject({ key: "stale", tone: "warning", label: "Stale" });
    expect(stale.title).toContain("2026-10-01 15:33Z");
    expect(nodeStatus(view({}, { unexplained: 3 }, "failed"), true)).toMatchObject({ key: "snapshot-unread", tone: "warning" });
    expect(nodeStatus(view({}, { unexplained: 3 }, "pending"), true)).toMatchObject({ key: "reading", tone: "neutral" });
  });

  it("never paints a node that has not reported as healthy", () => {
    const status = nodeStatus(view({ snapshotStatus: "unknown", driftState: "unknown", collectedAt: undefined }, { evidence: "none" }), true);
    expect(status).toMatchObject({ key: "never-reported", tone: "neutral", label: "Never reported" });
  });

  it("says a snapshot was not read, rather than never reported, when the reality read failed", () => {
    const unread = view({ snapshotStatus: "unknown", driftState: "unknown", collectedAt: undefined }, { evidence: "none" });
    expect(nodeStatus(unread, true, false)).toMatchObject({ key: "reality-unread", tone: "neutral", label: "Not read" });
    expect(nodeStatus(view({ snapshotStatus: "unknown", driftState: "unknown", lastError: "nft: exit 1" }, { evidence: "none" }), true, false).key).toBe("apply-failed");
    expect(nodeStatus(view(), true, false).key).toBe("enforced");
  });

  it("says ports are not judged when the declared rules were not read", () => {
    expect(nodeStatus(view({ coverage: "observe_only", driftState: "unknown" }, { rulesRead: false }), true)).toMatchObject({ key: "not-judged", label: "Not judged" });
  });

  it("tells the two reasons a managed node cannot be verified apart", () => {
    expect(nodeStatus(view({ driftState: "unknown", appliedTableSha: undefined }), true)).toMatchObject({ key: "never-applied", tone: "warning", label: "Never applied" });
    expect(nodeStatus(view({ driftState: "unknown", managedSha: undefined }), true)).toMatchObject({ key: "no-managed-table", tone: "warning" });
  });

  it("calls an unmanaged node with nothing unexplained not enforced, or unbound", () => {
    expect(nodeStatus(view({ coverage: "observe_only", driftState: "unknown" }, { enforced: false }), true)).toMatchObject({ key: "not-enforced", tone: "neutral", label: "Not enforced" });
    expect(nodeStatus(view({ coverage: "legacy", driftState: "unknown" }, { enforced: false }), true).title).toContain("legacy baseline");
    expect(nodeStatus(view({ coverage: "unbound", driftState: "unknown" }, { managedBy: { kind: "none" }, enforced: false }), true)).toMatchObject({ key: "no-binding", label: "No binding" });
  });

  it("states only the declared coverage to a session that cannot read reality", () => {
    expect(nodeStatus(view({ driftState: "drift" }), false)).toMatchObject({ key: "intent-only", tone: "neutral", label: "Managed" });
  });

  it("paints the error tone on exactly the rows the Needs attention filter keeps", () => {
    const rows = [
      view(),
      view({ driftState: "drift" }),
      view({ lastError: "boom" }),
      view({ coverage: "observe_only", driftState: "unknown" }, { unexplained: 2 }),
      view({ snapshotStatus: "stale" }, { evidence: "stale", unexplained: 2 }),
      view({ snapshotStatus: "unknown" }, { evidence: "none" }),
      view({}, { unexplained: 2 }, "pending"),
      view({ coverage: "unbound", driftState: "unknown" }, { managedBy: { kind: "none" } }),
    ];
    for (const candidate of rows) expect(nodeStatus(candidate, true).tone === "error").toBe(needsAttention(candidate));
  });
});

describe("orderedOpen", () => {
  it("puts the ports no rule allows first, then the unjudged, then the allowed, each in port order", () => {
    const ordered = orderedOpen([span(22, "allowed"), span(5432, "unexplained"), span(80, "unknown"), span(8080, "unexplained"), span(443, "allowed")]);
    expect(ordered.map((entry) => entry.from)).toEqual([5432, 8080, 80, 22, 443]);
  });
});

describe("confinedPhrase", () => {
  const gated = (from: number): ConfinedSpan => ({ protocol: "tcp", from, to: from, processes: [], scopes: [KNOCK_SCOPE] });
  it("folds gated ports into one word and names every other scope once", () => {
    const zoned: ConfinedSpan = { protocol: "tcp", from: 9100, to: 9100, processes: [], scopes: ["the tailscale zone"], bindZone: "tailscale" };
    const cidr: ConfinedSpan = { protocol: "udp", from: 8443, to: 8443, processes: [], scopes: ["10.7.0.0/24"] };
    expect(confinedPhrase([gated(22), gated(3434), zoned, cidr])).toBe("22, 3434 gated · 9100 via tailscale · 8443/udp via 10.7.0.0/24");
    expect(confinedPhrase([])).toBe("");
  });
});

describe("managedCell", () => {
  it("prints the groups, and the coverage only when it is not managed", () => {
    expect(managedCell(view())).toEqual({ names: "ssh", note: "", absent: false });
    expect(managedCell(view({ coverage: "observe_only" }))).toEqual({ names: "ssh", note: "observe only", absent: false });
    expect(managedCell(view({ coverage: "legacy" }, { managedBy: { kind: "legacy", names: [] } }))).toEqual({ names: "legacy rules", note: "not adopted", absent: false });
    expect(managedCell(view({ coverage: "unbound" }, { managedBy: { kind: "none" } }))).toEqual({ names: "no binding", note: "", absent: true });
  });

  it("says the binding was not read rather than none after a failed overview read", () => {
    expect(managedCell(view({ coverage: "unbound" }, { rulesRead: false, managedBy: { kind: "none" } }))).toEqual({ names: "not read", note: "", absent: true });
  });
});

describe("idAddsInformation", () => {
  it("leaves out an id that is only the name's slug", () => {
    expect(idAddsInformation("[Metix]-DMIT-2", "metix-dmit-2")).toBe(false);
    expect(idAddsInformation("[cd]-Aaitr-HK", "node_cd-aaitr-hk")).toBe(false);
    expect(idAddsInformation("fra-exit-02", "fra-exit-02")).toBe(false);
  });

  it("keeps an id that says something the name does not", () => {
    expect(idAddsInformation("[cd]-homeserver", "cd-nas-old")).toBe(true);
    expect(idAddsInformation("[openjobs-vpn]-SG-1", "node_4kd82mwqxr9tzb1v")).toBe(true);
  });

  it("prints no id under a row whose name is already the id", () => {
    expect(idAddsInformation("", "metix-dmit-2")).toBe(false);
  });
});
