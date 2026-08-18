import { describe, expect, it } from "vitest";

import {
  buildRemote,
  driftTone,
  formatRanges,
  orderListeners,
  parseRanges,
  severityTone,
  snapshotTone,
  suggestionsByPort,
} from "./netguardModel";

describe("netguardModel", () => {
  it("normalizes ordered single ports and ranges", () => {
    const ranges = parseRanges("443, 9009-9013, 22, 443");
    expect(ranges).toEqual([{ from: 22, to: 22 }, { from: 443, to: 443 }, { from: 9009, to: 9013 }]);
    expect(formatRanges(ranges)).toBe("22, 443, 9009-9013");
  });

  it("rejects reversed or out-of-range ports", () => {
    expect(() => parseRanges("9013-9009")).toThrow("outside");
    expect(() => parseRanges("70000")).toThrow("outside");
  });

  it("maps remote values to the declared reference kind only", () => {
    expect(buildRemote("zone", " tailscale ")).toEqual({ kind: "zone", zone_id: "tailscale" });
    expect(buildRemote("any", "ignored")).toEqual({ kind: "any" });
  });
});

describe("reality panel semantics", () => {
  it("never calls an incomparable state in sync", () => {
    // unknown means one side of the comparison is missing. Labelling that
    // "in sync" would be the most dangerous badge in the panel.
    expect(driftTone("unknown")).toBe("muted");
    expect(driftTone("in_sync")).toBe("ok");
    expect(driftTone("drift_detected")).toBe("danger");
    expect(driftTone("something-new")).toBe("warn");
  });

  it("treats an unrecognised snapshot status as worth attention", () => {
    expect(snapshotTone("fresh")).toBe("ok");
    expect(snapshotTone("stale")).toBe("warn");
    expect(snapshotTone("unknown")).toBe("muted");
    expect(snapshotTone("weird")).toBe("warn");
  });

  it("indexes suggestions by the port they are about", () => {
    const index = suggestionsByPort([
      { id: "1", code: "c", severity: "high", title: "t", detail: "d", port: 22 },
      { id: "2", code: "c", severity: "low", title: "t", detail: "d", port: 22 },
      { id: "3", code: "c", severity: "low", title: "t", detail: "d" },
      { id: "4", code: "c", severity: "low", title: "t", detail: "d", port: 0 },
    ]);
    expect([...index.keys()]).toEqual([22]);
    expect(index.get(22)?.length).toBe(2);
  });

  it("puts flagged listeners first, then orders by port", () => {
    const ordered = orderListeners(
      [{ port: 80 }, { port: 8443 }, { port: 22 }, { port: 443 }],
      new Set([8443, 22]),
    );
    expect(ordered.map((l) => l.port)).toEqual([22, 8443, 80, 443]);
  });

  it("maps severities to tones without inventing a quiet one", () => {
    expect(severityTone("HIGH")).toBe("danger");
    expect(severityTone("medium")).toBe("warn");
    expect(severityTone("info")).toBe("muted");
    expect(severityTone("")).toBe("warn");
  });
});
