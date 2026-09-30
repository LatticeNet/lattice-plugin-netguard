import { describe, expect, it } from "vitest";

import type { NodeExposure, OpenSpan } from "./exposure";
import {
  UNKNOWN_VALUE,
  attentionItems,
  needsAttention,
  overviewNumbers,
  portPicture,
  type DetailState,
  type ExposureRowView,
} from "./overview";
import { countPosture, type PostureRow } from "./posture";

function span(from: number, verdict: OpenSpan["verdict"], processes: string[] = [], to = from, protocol: "tcp" | "udp" = "tcp"): OpenSpan {
  return { protocol, from, to, processes, verdict };
}

function view(
  id: string,
  over: Partial<PostureRow> = {},
  open: OpenSpan[] = [],
  detail: DetailState = "loaded",
): ExposureRowView {
  const row: PostureRow = {
    nodeId: id,
    nodeName: id.toUpperCase(),
    coverage: "managed",
    snapshotStatus: "fresh",
    driftState: "in_sync",
    groupIds: [],
    zoneIds: [],
    ...over,
  };
  const evidence = row.snapshotStatus === "unknown" ? "none" : row.snapshotStatus === "stale" ? "stale" : "fresh";
  const exposure: NodeExposure = {
    nodeId: id,
    evidence,
    open,
    confined: [],
    unexplained: open.filter((item) => item.verdict === "unexplained").reduce((sum, item) => sum + item.to - item.from + 1, 0),
    managedBy: { kind: "none" },
    enforced: row.coverage === "managed" && row.driftState === "in_sync",
  };
  return { row, exposure, detail };
}

const fleet: ExposureRowView[] = [
  view("dmit-2", { driftState: "drift" }, [span(22, "allowed", ["sshd"]), span(5432, "unexplained", ["postgres"]), span(8080, "unexplained", ["nginx"])]),
  view("fra-exit-02", { driftState: "drift" }, [span(22, "allowed", ["sshd"]), span(8080, "unexplained", ["nginx"])]),
  view("lax-exit-02", { lastError: "selfcheck: control plane unreachable; rolled back" }, [span(22, "allowed", ["sshd"])]),
  view("hkg-edge-01", {}, [span(22, "allowed", ["sshd"]), span(31001, "allowed", ["sing-box"], 31012)]),
  view("build-1", { coverage: "observe_only", driftState: "unknown" }, [span(2375, "unexplained", ["dockerd"]), span(22, "unknown", ["sshd"])]),
  view("lab-2", { coverage: "observe_only", driftState: "unknown", snapshotStatus: "stale" }, [span(6443, "unexplained", ["kube-apiserver"])]),
  view("homeserver", { coverage: "legacy", driftState: "unknown" }, [span(22, "allowed", ["sshd"])]),
  view("pi-zero", { coverage: "unbound", driftState: "unknown", snapshotStatus: "unknown" }),
  view("sin-edge-01", {}, [span(9100, "unexplained", ["node_exporter"])], "pending"),
];

const readable = { canSeeReality: true, realityFailed: false };

describe("the attention list", () => {
  it("names the unexplained ports with their owners, then drift, then a failed apply", () => {
    const items = attentionItems(fleet, readable);
    expect(items.map((item) => [item.key, item.tone])).toEqual([
      ["unexplained", "danger"],
      ["drift", "danger"],
      ["apply-failed", "warning"],
    ]);
    expect(items[0]!.claim).toBe("4 ports open to the internet with no rule, on 3 nodes");
    expect(items[0]!.proof).toBe("DMIT-2 5432 postgres, 8080 nginx · FRA-EXIT-02 8080 nginx · BUILD-1 2375 dockerd");
    expect(items[0]!.action).toEqual({ label: "Review", kind: "nodes" });
    expect(items[1]!.claim).toBe("2 nodes drifted: the live table differs from what Lattice applied");
    expect(items[1]!.proof).toBe("DMIT-2, FRA-EXIT-02");
    expect(items[2]!.proof).toBe("LAX-EXIT-02: selfcheck: control plane unreachable; rolled back");
    expect(items[2]!.action).toEqual({ label: "Open LAX-EXIT-02", kind: "open", nodeId: "lax-exit-02" });
  });

  it("counts a port bank as its ports, and opens the node directly when only one is involved", () => {
    const items = attentionItems([view("one", {}, [span(31001, "unexplained", ["sing-box"], 31012)])], readable);
    expect(items[0]!.claim).toBe("12 ports open to the internet with no rule, on 1 node");
    expect(items[0]!.action).toEqual({ label: "Open ONE", kind: "open", nodeId: "one" });
  });

  it("never counts a stale, unread or never reported snapshot", () => {
    const items = attentionItems([fleet[5]!, fleet[7]!, fleet[8]!], readable);
    expect(items).toEqual([]);
  });

  it("says nothing about ports or drift when reality was not read, and still reports a failed apply", () => {
    for (const options of [{ canSeeReality: false, realityFailed: false }, { canSeeReality: true, realityFailed: true }]) {
      expect(attentionItems(fleet, options).map((item) => item.key)).toEqual(["apply-failed"]);
    }
  });

  it("folds long proofs into a count", () => {
    const many = Array.from({ length: 6 }, (_, index) => view(`n${index}`, {}, [span(8080 + index, "unexplained")]));
    expect(attentionItems(many, readable)[0]!.proof).toMatch(/· and 3 more nodes$/);
  });

  it("marks the nodes the Nodes filter keeps", () => {
    expect(fleet.filter(needsAttention).map((item) => item.row.nodeId)).toEqual(["dmit-2", "fra-exit-02", "lax-exit-02", "build-1"]);
  });
});

describe("the four numbers", () => {
  const counts = countPosture(fleet.map((item) => item.row));
  const source = { overviewFailed: false, realityFailed: false, canSeeReality: true, reading: { done: 8, total: 8 } };

  it("prints enforced over the fleet, unexplained ports, drift and observe only", () => {
    const numbers = overviewNumbers(counts, fleet, source);
    expect(numbers.map((number) => [number.label, number.value])).toEqual([
      ["Enforced", "3 / 9"],
      ["Unexplained ports", "4"],
      ["Drift", "2"],
      ["Observe only", "2"],
    ]);
    expect(numbers[1]!.note).toBe("open with no rule, on 3 nodes");
    expect(numbers[3]!.note).toBe("nothing enforced · also 1 legacy baseline, 1 unbound");
  });

  it("says a snapshot read is still running instead of calling the count final", () => {
    const numbers = overviewNumbers(counts, fleet, { ...source, reading: { done: 3, total: 8 } });
    expect(numbers[1]!.note).toBe("reading 3 of 8 snapshots");
  });

  it("prints unknown, never a zero, for a number whose read failed", () => {
    const realityLost = overviewNumbers(counts, fleet, { ...source, realityFailed: true });
    expect(realityLost.map((number) => number.value)).toEqual([UNKNOWN_VALUE, UNKNOWN_VALUE, UNKNOWN_VALUE, "2"]);
    const overviewLost = overviewNumbers(counts, fleet, { ...source, overviewFailed: true });
    expect(overviewLost.map((number) => number.value)).toEqual([UNKNOWN_VALUE, "4", "2", UNKNOWN_VALUE]);
    const noScope = overviewNumbers(counts, fleet, { ...source, canSeeReality: false });
    expect(noScope[2]!.note).toBe("reality not readable by this session");
  });
});

describe("the ports picture", () => {
  it("puts ports with an unexplained node first, then the most common, and leaves unread nodes out with a reason", () => {
    const picture = portPicture(fleet);
    expect(picture.rows.map((row) => [row.label, row.unexplained, row.unknown, row.allowed])).toEqual([
      ["8080/tcp", 2, 0, 0],
      ["2375/tcp", 1, 0, 0],
      ["5432/tcp", 1, 0, 0],
      ["22/tcp", 0, 1, 5],
      ["31001-31012/tcp", 0, 0, 1],
    ]);
    expect(picture.rows[0]!.nodes.map((node) => node.nodeName)).toEqual(["DMIT-2", "FRA-EXIT-02"]);
    expect(picture.rows[3]!.nodes[0]).toEqual({ nodeId: "build-1", nodeName: "BUILD-1", verdict: "unknown" });
    expect(picture.rows[0]!.processes).toEqual(["nginx"]);
    expect(picture.rows[4]!.search).toBe("31001");
    expect({ counted: picture.counted, stale: picture.stale, neverReported: picture.neverReported, unread: picture.unread }).toEqual({ counted: 6, stale: 1, neverReported: 1, unread: 1 });
  });

  it("is empty for a fleet with nothing read", () => {
    expect(portPicture([]).rows).toEqual([]);
  });
});
