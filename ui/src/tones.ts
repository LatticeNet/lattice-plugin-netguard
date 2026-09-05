import type { StateTone } from "@latticenet/plugin-bridge/chassis";

import type { Tone } from "./posture";

/**
 * NetGuard's four verdict tones, read onto the chassis's state vocabulary.
 * The posture and model modules keep their own names because they are the
 * server's words (ok, warn, danger, muted); the chassis paints healthy,
 * warning, error and neutral. One function, so the mapping cannot drift
 * between the table, the detail and the findings list.
 */
export function stateTone(tone: Tone | string): StateTone {
  if (tone === "ok") return "healthy";
  if (tone === "warn") return "warning";
  if (tone === "danger") return "error";
  return "neutral";
}
