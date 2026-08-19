/**
 * A line diff for firewall rulesets.
 *
 * An operator must be able to see what an apply changes before it reaches a
 * node. The honest scope of that is narrow and worth stating precisely: a
 * reality snapshot reports the live managed table only as a hash, never as
 * text, so no client can diff against what is physically on the box. What can
 * be diffed is Lattice's intent before and after an edit, which is exactly the
 * change the operator is about to commit.
 *
 * Everything here is pure and DOM-free.
 */

export type DiffKind = "same" | "add" | "remove";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number on the side the line exists on. */
  oldLine?: number;
  newLine?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface RulesetDiff {
  lines: DiffLine[];
  stats: DiffStats;
  /** True when both sides are byte-identical after normalization. */
  identical: boolean;
  /**
   * Set when the inputs were too large to diff exactly. The lines are then a
   * whole-file replacement rather than a minimal edit script, and saying so
   * beats quietly showing a worse diff.
   */
  truncated: boolean;
}

/**
 * Above this many lines on either side the quadratic LCS table is not worth
 * building inside a plugin frame. Real lattice_guard rulesets are tens of
 * lines, so this only trips on something pathological.
 */
const MAX_DIFF_LINES = 4000;

function splitLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!normalized) return [];
  return normalized.split("\n");
}

/**
 * Longest common subsequence over lines, walked back into an edit script.
 *
 * Rule ORDER is meaning in nftables, so this must never reorder or match lines
 * out of sequence to make a diff look smaller.
 */
function lcsLengths(a: readonly string[], b: readonly string[]): Int32Array[] {
  const table: Int32Array[] = [];
  for (let i = 0; i <= a.length; i++) table.push(new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return table;
}

export function diffRulesets(before: string, after: string): RulesetDiff {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");

  if (a.length === b.length && a.every((line, index) => line === b[index])) {
    return {
      lines: a.map((text, index) => ({
        kind: "same" as const,
        text,
        oldLine: index + 1,
        newLine: index + 1,
      })),
      stats: { added: 0, removed: 0, unchanged: a.length },
      identical: true,
      truncated: false,
    };
  }

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    const lines: DiffLine[] = [
      ...a.map((text, index) => ({ kind: "remove" as const, text, oldLine: index + 1 })),
      ...b.map((text, index) => ({ kind: "add" as const, text, newLine: index + 1 })),
    ];
    return {
      lines,
      stats: { added: b.length, removed: a.length, unchanged: 0 },
      identical: false,
      truncated: true,
    };
  }

  const table = lcsLengths(a, b);
  const lines: DiffLine[] = [];
  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      stats.unchanged++;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: "remove", text: a[i]!, oldLine: i + 1 });
      stats.removed++;
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]!, newLine: j + 1 });
      stats.added++;
      j++;
    }
  }
  while (i < a.length) {
    lines.push({ kind: "remove", text: a[i]!, oldLine: i + 1 });
    stats.removed++;
    i++;
  }
  while (j < b.length) {
    lines.push({ kind: "add", text: b[j]!, newLine: j + 1 });
    stats.added++;
    j++;
  }

  return { lines, stats, identical: false, truncated: false };
}

/**
 * Collapse long unchanged runs, keeping `context` lines around every change.
 * A firewall diff is read for what moved, and 60 identical scaffold lines
 * between two edits push the second one off the screen.
 */
export function collapseUnchanged(lines: readonly DiffLine[], context = 3): (DiffLine | { kind: "gap"; hidden: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.kind === "same") continue;
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep[target] = true;
    }
  }
  const out: (DiffLine | { kind: "gap"; hidden: number })[] = [];
  let hidden = 0;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index]) {
      if (hidden > 0) {
        out.push({ kind: "gap", hidden });
        hidden = 0;
      }
      out.push(lines[index]!);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}

/** A one-line plain-language summary, for places too small for the diff. */
export function summarizeDiff(diff: RulesetDiff): string {
  if (diff.identical) return "no change to the intended ruleset";
  const parts: string[] = [];
  if (diff.stats.added) parts.push(`${diff.stats.added} line${diff.stats.added === 1 ? "" : "s"} added`);
  if (diff.stats.removed) parts.push(`${diff.stats.removed} line${diff.stats.removed === 1 ? "" : "s"} removed`);
  return parts.join(", ") || "no change to the intended ruleset";
}
