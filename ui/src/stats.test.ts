import { describe, expect, it } from "vitest";

import type { PostureCounts } from "./posture";
import { statTiles, UNKNOWN_VALUE } from "./stats";

const counts: PostureCounts = {
  total: 33,
  managed: 25,
  observeOnly: 4,
  legacy: 2,
  unbound: 2,
  drifted: 2,
  inSync: 23,
  driftUnknown: 8,
  neverReported: 1,
  stale: 2,
  fresh: 30,
  withForeignTables: 3,
  withApplyError: 1,
};

const known = { overviewFailed: false, realityFailed: false, canSeeReality: true };

describe("statTiles", () => {
  it("prints the five counts when both reads answered", () => {
    const tiles = statTiles(counts, known);
    expect(tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Nodes", 33],
      ["Managed", 25],
      ["Observe only", 4],
      ["Drift", 2],
      ["Stale", 2],
    ]);
    expect(tiles.map((tile) => tile.tone)).toEqual([undefined, undefined, "neutral", "error", "warning"]);
    expect(tiles.every((tile) => !tile.unknown)).toBe(true);
  });

  it("colours nothing when nothing has drifted or gone stale", () => {
    const tiles = statTiles({ ...counts, drifted: 0, stale: 0 }, known);
    expect(tiles.find((tile) => tile.label === "Drift")?.tone).toBeUndefined();
    expect(tiles.find((tile) => tile.label === "Stale")?.tone).toBeUndefined();
  });

  it("renders every tile as unknown, never as a confident zero, when every read failed", () => {
    // A firewall panel that renders an unreported fleet as a quiet one is
    // worse than no panel at all: "Drift 0" on a page that loaded nothing
    // states that nothing has drifted, when in fact nothing is known.
    const empty: PostureCounts = { ...counts, total: 0, managed: 0, observeOnly: 0, drifted: 0, stale: 0 };
    const tiles = statTiles(empty, { overviewFailed: true, realityFailed: true, canSeeReality: true });
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) {
      expect(tile.unknown, tile.label).toBe(true);
      expect(tile.value, tile.label).toBe(UNKNOWN_VALUE);
      expect(tile.tone, tile.label).toBe("neutral");
      expect(tile.note, tile.label).toMatch(/could not be loaded/);
    }
  });

  it("blanks only the tiles the failed read feeds", () => {
    // The overview carries bindings, so Managed and Observe only need it;
    // reality carries drift and snapshot age, so Drift and Stale need it;
    // Nodes is the join of both.
    const overviewDown = statTiles(counts, { overviewFailed: true, realityFailed: false, canSeeReality: true });
    expect(overviewDown.map((tile) => tile.unknown)).toEqual([true, true, true, false, false]);
    expect(overviewDown[3]?.value).toBe(2);

    const realityDown = statTiles(counts, { overviewFailed: false, realityFailed: true, canSeeReality: true });
    expect(realityDown.map((tile) => tile.unknown)).toEqual([true, false, false, true, true]);
    expect(realityDown[1]?.value).toBe(25);
  });

  it("says reality is not readable instead of counting zero drift for a session without the scope", () => {
    const tiles = statTiles({ ...counts, drifted: 0, stale: 0 }, { ...known, canSeeReality: false });
    expect(tiles.map((tile) => tile.unknown)).toEqual([false, false, false, true, true]);
    expect(tiles[3]?.note).toMatch(/not readable/);
  });
});
