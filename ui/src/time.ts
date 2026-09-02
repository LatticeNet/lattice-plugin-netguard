/**
 * Time labels for evidence.
 *
 * This plugin holds no timer (frameModel.test.ts guards that), so a relative
 * age is only true at the moment it is rendered. Every relative label here is
 * therefore paired with the absolute instant it was computed from, and the
 * absolute form is UTC with the zone marked, the way the spec writes
 * `applied 2026-09-02 03:52Z`.
 */

export function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** "41s", "12m", "3h", "2d"; "?" when the value does not parse. */
export function ageLabel(value: string | undefined, now: number): string {
  const parsed = parseTime(value);
  if (parsed === undefined) return "?";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "03:52:10Z". */
export function clockUtc(value: string | number | undefined): string {
  const parsed = typeof value === "number" ? value : parseTime(value);
  if (parsed === undefined) return "";
  const date = new Date(parsed);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/** "2026-09-02 03:52Z". */
export function stampUtc(value: string | number | undefined): string {
  const parsed = typeof value === "number" ? value : parseTime(value);
  if (parsed === undefined) return "";
  const date = new Date(parsed);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}
