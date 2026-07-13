import { describe, expect, it } from "vitest";

import { buildRemote, formatRanges, parseRanges } from "./netguardModel";

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
