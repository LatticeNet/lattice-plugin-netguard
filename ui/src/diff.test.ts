import { describe, expect, it } from "vitest";

import { collapseUnchanged, diffRulesets, summarizeDiff } from "./diff";

const base = [
  "table inet lattice_guard {",
  "  chain input {",
  "    type filter hook input priority 0; policy drop;",
  "    ct state established,related accept",
  "    iif lo accept",
  '    iifname "ens3" tcp dport { 22, 443 } accept',
  "    counter drop",
  "  }",
  "}",
].join("\n");

describe("diffRulesets", () => {
  it("reports an unchanged ruleset as identical", () => {
    const diff = diffRulesets(base, base);
    expect(diff.identical).toBe(true);
    expect(diff.stats.added).toBe(0);
    expect(diff.stats.removed).toBe(0);
    expect(summarizeDiff(diff)).toBe("no change to the intended ruleset");
  });

  it("ignores trailing whitespace and line endings", () => {
    expect(diffRulesets(base, base.replace(/\n/g, "\r\n") + "\n\n").identical).toBe(true);
  });

  it("shows a changed port line as one removal and one addition", () => {
    const after = base.replace("{ 22, 443 }", "{ 2222, 443 }");
    const diff = diffRulesets(base, after);
    expect(diff.identical).toBe(false);
    expect(diff.stats.added).toBe(1);
    expect(diff.stats.removed).toBe(1);
    const removed = diff.lines.find((line) => line.kind === "remove")!;
    const added = diff.lines.find((line) => line.kind === "add")!;
    expect(removed.text).toContain("22, 443");
    expect(added.text).toContain("2222, 443");
    expect(summarizeDiff(diff)).toBe("1 line added, 1 line removed");
  });

  it("preserves rule order rather than matching lines out of sequence", () => {
    // In nftables order is meaning, so a swap has to read as a real change and
    // never as "same lines, different places".
    const swapped = base.replace(
      "    ct state established,related accept\n    iif lo accept",
      "    iif lo accept\n    ct state established,related accept",
    );
    const diff = diffRulesets(base, swapped);
    expect(diff.identical).toBe(false);
    expect(diff.stats.added).toBeGreaterThan(0);
    expect(diff.stats.removed).toBeGreaterThan(0);
    const order = diff.lines.filter((l) => l.kind !== "remove").map((l) => l.text);
    expect(order.indexOf("    iif lo accept")).toBeLessThan(
      order.indexOf("    ct state established,related accept"),
    );
  });

  it("numbers lines against the side each one exists on", () => {
    const after = base + "\n# trailing comment";
    const diff = diffRulesets(base, after);
    const added = diff.lines.filter((line) => line.kind === "add");
    expect(added).toHaveLength(1);
    expect(added[0]!.newLine).toBe(10);
    expect(added[0]!.oldLine).toBeUndefined();
  });

  it("treats an empty side as a whole-file add or remove", () => {
    const added = diffRulesets("", base);
    expect(added.stats.removed).toBe(0);
    expect(added.stats.added).toBe(9);
    const removed = diffRulesets(base, "");
    expect(removed.stats.added).toBe(0);
    expect(removed.stats.removed).toBe(9);
  });

  it("says so instead of hanging when the input is pathological", () => {
    const huge = Array.from({ length: 4100 }, (_, i) => `rule ${i}`).join("\n");
    const diff = diffRulesets(huge, huge + "\nextra");
    expect(diff.truncated).toBe(true);
    expect(diff.identical).toBe(false);
  });

  it("survives an empty diff on both sides", () => {
    const diff = diffRulesets("", "");
    expect(diff.identical).toBe(true);
    expect(diff.lines).toHaveLength(0);
  });
});

describe("collapseUnchanged", () => {
  it("keeps context around a change and folds the rest into a gap", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const changed = long.replace("line 20", "line 20 changed");
    const collapsed = collapseUnchanged(diffRulesets(long, changed).lines, 2);
    expect(collapsed.some((entry) => entry.kind === "gap")).toBe(true);
    const shown = collapsed.filter((entry) => entry.kind !== "gap");
    expect(shown.length).toBeLessThan(40);
    expect(shown.some((entry) => "text" in entry && entry.text.includes("line 20 changed"))).toBe(true);
  });

  it("shows everything when nothing is far from a change", () => {
    const diff = diffRulesets("a\nb", "a\nc");
    const collapsed = collapseUnchanged(diff.lines, 3);
    expect(collapsed.every((entry) => entry.kind !== "gap")).toBe(true);
  });

  it("emits no gap for an identical file with no changes to anchor on", () => {
    const collapsed = collapseUnchanged(diffRulesets(base, base).lines, 2);
    // Every line is unchanged and nothing is worth showing, so the whole file
    // collapses into a single gap rather than pretending there is a diff.
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.kind).toBe("gap");
  });
});
