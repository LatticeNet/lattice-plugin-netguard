/**
 * The stat strip's five tiles, with honesty about what fed them.
 *
 * The counts are a join of two reads: the overview carries bindings (managed,
 * observe only), reality carries drift and snapshot age, and Nodes is the
 * union of both rosters. When a read failed, the tiles it feeds say so
 * instead of printing the zero an empty join produces: "Drift 0" on a page
 * that loaded nothing states that nothing has drifted, when in fact nothing
 * is known, and the strip is the dominant element on the screen.
 */
import type { PostureCounts } from "./posture";

export type StatTone = "warning" | "error" | "neutral";

export interface StatSource {
  overviewFailed: boolean;
  realityFailed: boolean;
  /** The session holds the scope to read node reality at all. */
  canSeeReality: boolean;
}

export interface StatTile {
  label: string;
  value: string | number;
  note: string;
  tone?: StatTone;
  /** The read that feeds this tile did not answer; the value is a placeholder. */
  unknown: boolean;
}

export const UNKNOWN_VALUE = "unknown";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function unknownTile(label: string, note: string): StatTile {
  return { label, value: UNKNOWN_VALUE, note, tone: "neutral", unknown: true };
}

export function statTiles(counts: PostureCounts, source: StatSource): StatTile[] {
  const overviewNote = "the overview could not be loaded";
  const realityNote = source.realityFailed ? "reality could not be loaded" : "reality not readable by this session";
  const realityMissing = source.realityFailed || !source.canSeeReality;

  const nodes: StatTile = source.overviewFailed
    ? unknownTile("Nodes", overviewNote)
    : source.realityFailed
      ? unknownTile("Nodes", realityNote)
      : {
          label: "Nodes",
          value: counts.total,
          note: `${counts.fresh} reporting · ${plural(counts.legacy, "legacy baseline", "legacy baselines")} · ${counts.unbound} unbound`,
          unknown: false,
        };
  const managed: StatTile = source.overviewFailed
    ? unknownTile("Managed", overviewNote)
    : { label: "Managed", value: counts.managed, note: "under NetGuard authority", unknown: false };
  const observeOnly: StatTile = source.overviewFailed
    ? unknownTile("Observe only", overviewNote)
    : { label: "Observe only", value: counts.observeOnly, note: "visible, nothing enforced", tone: "neutral", unknown: false };
  const drift: StatTile = realityMissing
    ? unknownTile("Drift", realityNote)
    : {
        label: "Drift",
        value: counts.drifted,
        note: counts.drifted ? "live table differs from what Lattice applied" : `${counts.inSync} in sync · ${counts.driftUnknown} unknown`,
        tone: counts.drifted ? "error" : undefined,
        unknown: false,
      };
  const stale: StatTile = realityMissing
    ? unknownTile("Stale", realityNote)
    : {
        label: "Stale",
        value: counts.stale,
        note: counts.stale ? "snapshot older than the server trusts" : `${counts.fresh} fresh · ${counts.neverReported} never reported`,
        tone: counts.stale ? "warning" : undefined,
        unknown: false,
      };
  return [nodes, managed, observeOnly, drift, stale];
}
