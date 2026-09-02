import { describe, expect, it } from "vitest";

import {
  attentionRank,
  definiteTime,
  countPosture,
  coverageLabel,
  driftShortReason,
  driftToneFor,
  driftUnknownReason,
  joinPosture,
  matchesFilter,
  searchPosture,
  sortPosture,
  type PostureRow,
} from "./posture";
import { driftTone, type GuardNode, type RealitySummary } from "./netguardModel";

function intent(nodeId: string, over: Partial<GuardNode> = {}): GuardNode {
  return {
    node_id: nodeId,
    node_name: `Name ${nodeId}`,
    source: "stored",
    binding: {
      node_id: nodeId,
      group_ids: [],
      zone_ids: [],
      managed: true,
      version: 1,
    },
    groups: [],
    zones: [],
    ...over,
  };
}

function summary(nodeId: string, over: Partial<RealitySummary> = {}): RealitySummary {
  return { node_id: nodeId, snapshot_status: "fresh", drift_state: "in_sync", ...over };
}

describe("joinPosture", () => {
  it("keeps a node that only reality knows about", () => {
    // The reality list is the full roster. A node with no binding at all still
    // has to appear, or a firewall inventory quietly omits uncovered machines.
    const rows = joinPosture([], [summary("n1", { snapshot_status: "unknown", drift_state: "unknown" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coverage).toBe("unbound");
    expect(rows[0]!.snapshotStatus).toBe("unknown");
  });

  it("keeps a node that only intent knows about", () => {
    const rows = joinPosture([intent("n2")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nodeId).toBe("n2");
    expect(rows[0]!.snapshotStatus).toBe("unknown");
  });

  it("does not emit a node twice when both halves know it", () => {
    const rows = joinPosture([intent("n3")], [summary("n3")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coverage).toBe("managed");
    expect(rows[0]!.driftState).toBe("in_sync");
  });

  it("treats an unrecognised status or drift value as unknown, never as healthy", () => {
    const rows = joinPosture([], [summary("n4", { snapshot_status: "weird", drift_state: "nonsense" })]);
    expect(rows[0]!.snapshotStatus).toBe("unknown");
    expect(rows[0]!.driftState).toBe("unknown");
  });

  it("reads coverage from the binding", () => {
    const observe = intent("n5", { binding: { node_id: "n5", group_ids: [], managed: false, version: 1 } });
    const legacy = intent("n6", { source: "legacy" });
    const rows = joinPosture([observe, legacy], [summary("n5"), summary("n6")]);
    expect(rows.find((r) => r.nodeId === "n5")!.coverage).toBe("observe_only");
    expect(rows.find((r) => r.nodeId === "n6")!.coverage).toBe("legacy");
  });

  it("leaves counts undefined for a node that never reported", () => {
    // Rendering a missing count as 0 would claim the node has no listeners,
    // when the truth is that nobody has looked.
    const rows = joinPosture([intent("n7")], [summary("n7", { snapshot_status: "unknown", drift_state: "unknown" })]);
    expect(rows[0]!.listenerCount).toBeUndefined();
    expect(rows[0]!.foreignTableCount).toBeUndefined();
  });
});

describe("countPosture", () => {
  it("splits the fleet without double counting", () => {
    const rows = joinPosture(
      [intent("a"), intent("b"), intent("c")],
      [
        summary("a", { drift_state: "drift", foreign_table_count: 2 }),
        summary("b", { snapshot_status: "unknown", drift_state: "unknown" }),
        summary("c", { snapshot_status: "stale", drift_state: "in_sync", last_error: "apply failed" }),
      ],
    );
    const counts = countPosture(rows);
    expect(counts.total).toBe(3);
    expect(counts.managed).toBe(3);
    expect(counts.drifted).toBe(1);
    expect(counts.neverReported).toBe(1);
    expect(counts.stale).toBe(1);
    expect(counts.fresh).toBe(1);
    expect(counts.withForeignTables).toBe(1);
    expect(counts.withApplyError).toBe(1);
    expect(counts.fresh + counts.stale + counts.neverReported).toBe(counts.total);
    expect(counts.inSync + counts.drifted + counts.driftUnknown).toBe(counts.total);
  });
});

describe("attention ordering", () => {
  it("ranks drift above every other problem", () => {
    const rows = joinPosture(
      [intent("a"), intent("b"), intent("c"), intent("d")],
      [
        summary("a"),
        summary("b", { snapshot_status: "unknown", drift_state: "unknown" }),
        summary("c", { drift_state: "drift" }),
        summary("d", { snapshot_status: "stale", drift_state: "unknown" }),
      ],
    );
    const sorted = sortPosture(rows, "attention", "asc");
    expect(sorted[0]!.nodeId).toBe("c");
    expect(sorted[sorted.length - 1]!.nodeId).toBe("a");
  });

  it("breaks ties on node id so a re-sort never shuffles rows", () => {
    const rows = joinPosture(
      [intent("z"), intent("y"), intent("x")],
      [summary("z"), summary("y"), summary("x")],
    );
    expect(sortPosture(rows, "attention", "asc").map((r) => r.nodeId)).toEqual(["x", "y", "z"]);
  });

  it("sorts a missing listener count below zero rather than above every node", () => {
    const rows = joinPosture(
      [intent("a"), intent("b")],
      [summary("a", { listener_count: 0 }), summary("b", { snapshot_status: "unknown" })],
    );
    const sorted = sortPosture(rows, "listeners", "asc");
    expect(sorted[0]!.nodeId).toBe("b");
  });
});

describe("filters", () => {
  const rows = joinPosture(
    [intent("a"), intent("b", { binding: { node_id: "b", group_ids: [], managed: false, version: 1 } })],
    [
      summary("a", { drift_state: "drift", foreign_table_count: 1, last_error: "boom" }),
      summary("b", { snapshot_status: "unknown", drift_state: "unknown" }),
    ],
  );

  it("matches each posture question", () => {
    const a = rows.find((r) => r.nodeId === "a")!;
    const b = rows.find((r) => r.nodeId === "b")!;
    expect(matchesFilter(a, "drifted")).toBe(true);
    expect(matchesFilter(b, "drifted")).toBe(false);
    expect(matchesFilter(b, "never_reported")).toBe(true);
    expect(matchesFilter(a, "foreign_tables")).toBe(true);
    expect(matchesFilter(b, "unmanaged")).toBe(true);
    expect(matchesFilter(a, "unmanaged")).toBe(false);
    expect(matchesFilter(a, "apply_error")).toBe(true);
    expect(matchesFilter(b, "all")).toBe(true);
  });

  it("searches id, name, groups and zones", () => {
    const withGroup = joinPosture(
      [intent("n1", { binding: { node_id: "n1", group_ids: ["web-tier"], zone_ids: [], managed: true, version: 1 } })],
      [summary("n1")],
    );
    expect(searchPosture(withGroup, "web")).toHaveLength(1);
    expect(searchPosture(withGroup, "Name n1")).toHaveLength(1);
    expect(searchPosture(withGroup, "absent")).toHaveLength(0);
    expect(searchPosture(withGroup, "   ")).toHaveLength(1);
  });
});

describe("honest unknowns", () => {
  it("distinguishes never reported from never applied", () => {
    const neverReported: PostureRow = joinPosture(
      [intent("a")],
      [summary("a", { snapshot_status: "unknown", drift_state: "unknown" })],
    )[0]!;
    expect(driftUnknownReason(neverReported)).toContain("never reported");

    const neverApplied: PostureRow = joinPosture(
      [intent("b")],
      [summary("b", { drift_state: "unknown", managed_sha: "abc" })],
    )[0]!;
    expect(driftUnknownReason(neverApplied)).toContain("never applied");

    const noManagedTable: PostureRow = joinPosture(
      [intent("c")],
      [summary("c", { drift_state: "unknown", applied_table_sha: "abc" })],
    )[0]!;
    expect(driftUnknownReason(noManagedTable)).toContain("managed table is absent");
  });

  it("never renders unknown drift as healthy", () => {
    expect(driftToneFor("unknown")).toBe("muted");
    expect(driftToneFor("drift")).toBe("danger");
    expect(driftToneFor("in_sync")).toBe("ok");
  });

  it("maps the server's drift constant to the danger tone", () => {
    // The server emits "drift". The tone helper compared against
    // "drift_detected", so the one state that must shout rendered quietly.
    expect(driftTone("drift")).toBe("danger");
    expect(driftTone("in_sync")).toBe("ok");
    expect(driftTone("unknown")).toBe("muted");
  });

  it("labels coverage in words an operator uses", () => {
    expect(coverageLabel("managed")).toBe("managed");
    expect(coverageLabel("observe_only")).toBe("observe only");
    expect(coverageLabel("unbound")).toBe("no binding");
  });

  it("ranks a clean node at zero attention", () => {
    const clean = joinPosture([intent("a")], [summary("a")])[0]!;
    expect(attentionRank(clean)).toBe(0);
  });
});

describe("definiteTime", () => {
  it("treats Go's unset time.Time as absent", () => {
    // Go marshals an unset time as this rather than omitting the field, and it
    // parses fine, so it reached the UI as an age of roughly 735846 days.
    expect(definiteTime("0001-01-01T00:00:00Z")).toBeUndefined();
  });

  it("treats a missing, empty or unparseable value as absent", () => {
    expect(definiteTime(undefined)).toBeUndefined();
    expect(definiteTime("")).toBeUndefined();
    expect(definiteTime("not a date")).toBeUndefined();
  });

  it("keeps a real timestamp", () => {
    expect(definiteTime("2026-08-19T08:36:18Z")).toBe("2026-08-19T08:36:18Z");
  });

  it("does not report an apply for a node that was never applied to", () => {
    const [row] = joinPosture(
      [{ node_id: "n1", node_name: "n1", binding: { last_applied_at: "0001-01-01T00:00:00Z" } } as never],
      [],
    );
    expect(row.lastAppliedAt).toBeUndefined();
  });
});

describe("driftShortReason", () => {
  it("names the missing side in a few words", () => {
    const base = joinPosture([intent("a")], [summary("a", { snapshot_status: "unknown", drift_state: "unknown" })])[0]!;
    expect(driftShortReason(base)).toBe("never reported");
    expect(driftShortReason({ ...base, snapshotStatus: "fresh" })).toBe("never applied");
    expect(driftShortReason({ ...base, snapshotStatus: "fresh", appliedTableSha: "a" })).toBe("no managed table");
    expect(driftShortReason({ ...base, snapshotStatus: "fresh", appliedTableSha: "a", managedSha: "b", driftState: "drift" })).toBe("live table differs");
    expect(driftShortReason({ ...base, driftState: "in_sync" })).toBe("");
  });
});
