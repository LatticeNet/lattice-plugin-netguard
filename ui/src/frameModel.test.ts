import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const components = () => readdirSync(fileURLToPath(new URL("./components", import.meta.url))).filter((name) => name.endsWith(".vue"));

describe("netguard frame model", () => {
  it("never reports its own height back to the host", () => {
    // The host frame is a viewport it sizes itself and it ignores the reported
    // number. Measuring the document to say how tall it is costs a full
    // synchronous layout on every body resize and buys nothing.
    const app = read("./App.vue");
    expect(app).not.toContain("ResizeObserver");
    expect(app).not.toContain("bridge?.resize");
    expect(app).not.toContain("bridge.resize");
  });

  it("keeps page data operator-driven instead of interval-polled", () => {
    // A background reload re-sorts the fleet and moves rows under the
    // pointer, and in a panel whose rows open a node and whose buttons apply
    // a firewall that is how the wrong node gets clicked. Refresh is a button.
    const app = read("./App.vue");
    expect(app).not.toContain("setInterval");
    expect(app).toContain('@click="refresh(true)"');
  });

  it("holds the row order while the per-node snapshot reads stream in", () => {
    // The default order ranks by unexplained ports, which every node reports
    // as 0 until its own detail call returns, so a live sort reshuffles the
    // table for the first seconds after load. The page settles the order at
    // known points (list painted, fan-in complete, operator sorted) and reads
    // rows through that settled index in between.
    const app = read("./App.vue");
    expect(app).toContain("settleOrder(");
    expect(app).toContain("applyOrder(");
    expect(app).not.toMatch(/\.sort\(\s*\(a, b\) => compareExposure/);
  });

  it("renders on the shared plugin chassis and nothing else", () => {
    // The skeleton is the chassis's: one stylesheet, imported once before the
    // plugin's own, and the page parts come from the chassis package rather
    // than a local copy of a modal, a pill or a table.
    const main = read("./main.ts");
    expect(main.indexOf("@latticenet/plugin-bridge/chassis.css")).toBeGreaterThan(-1);
    expect(main.indexOf("@latticenet/plugin-bridge/chassis.css")).toBeLessThan(main.indexOf("./styles.css"));
    const app = read("./App.vue");
    for (const part of ["PcWorkspace", "PcPageHeader", "PcProofLine", "PcStatStrip", "PcToolbar", "PcLensTabs", "PcPanel", "useOverlayEscape"]) {
      expect(app, part).toContain(part);
    }
    for (const editor of ["ApplyDialog", "GroupEditor", "ZoneEditor", "BindingEditor"]) {
      const source = read(`./components/${editor}.vue`);
      expect(source, editor).toContain("PcModal");
      expect(source, editor).not.toContain("getBoundingClientRect");
    }
  });

  it("renders on a chassis whose table header can pin to the frame", () => {
    // `.pc-table th` is sticky, which only works when the wrap around the
    // table is not itself a scroll container: `overflow-x: auto` computes
    // overflow-y to auto as well, and the header then pins to a box that never
    // scrolls vertically and rides off with the rows. The vendored chassis
    // build has to carry the fix, or the column labels are gone for most of a
    // 33 row exposure table.
    const css = read("../node_modules/@latticenet/plugin-bridge/dist/chassis/chassis.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const wrap = css.match(/\n\.pc-table-wrap\s*\{([^}]*)\}/);
    expect(wrap, "a .pc-table-wrap rule").toBeTruthy();
    expect(wrap![1]).toMatch(/overflow-x:\s*clip/);
    expect(wrap![1]).not.toMatch(/overflow-x:\s*auto/);
    expect(css).toMatch(/\.pc-table-wrap\[data-overflow="x"\]\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("renders on a chassis whose lens strip wraps in a 375 frame", () => {
    // Four tabs with counts need 378px and the stretched strip has 341 at
    // 375. A chassis that scrolls the strip instead hides the Zones tab off
    // the right edge with nothing to say it is there.
    const css = read("../node_modules/@latticenet/plugin-bridge/dist/chassis/chassis.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const narrow = css.slice(css.indexOf("@media (max-width: 620px)"));
    const strip = narrow.match(/\n\s*\.pc-lens-tabs\s*\{([^}]*)\}/);
    expect(strip, "a narrow .pc-lens-tabs rule").toBeTruthy();
    expect(strip![1]).toMatch(/flex-wrap:\s*wrap/);
    expect(strip![1]).not.toMatch(/overflow-x/);
  });

  it("keeps the exposure table inside a 1024 frame", () => {
    // 1024 is the console's content width once its sidebar is open. The
    // chassis workspace pads clamp(16px, 2.2vw, 24px) a side and the card has
    // a 1px border, so the table's floor has to stay under 1024 - 48 - 2. Past
    // it the wrap scrolls sideways, the sticky actions column lands on the
    // drift text, and the only scrollbar is under the last row.
    const table = read("./components/ExposureTable.vue");
    const minWidth = Number(table.match(/<PcTable[^>]*:min-width="(\d+)"/)?.[1]);
    expect(minWidth).toBeGreaterThan(0);
    expect(minWidth).toBeLessThanOrEqual(1024 - 2 * 24 - 2);
  });

  it("gives the toolbar the same shape on every lens", () => {
    // The reference page keeps a search field and one primary action in the
    // toolbar on every tab. A search that vanishes when the lens changes is a
    // control the operator cannot learn.
    const app = read("./App.vue");
    expect(app).toMatch(/<template #search>/);
    expect(app).not.toMatch(/<template v-if="[^"]*" #search>/);
    expect(app).toMatch(/lens === 'exposure'[^\n]*#primary|#primary[^\n]*lens === 'exposure'|<template v-if="canAdmin && !loading" #primary>/);
  });

  it("promotes the findings to a lens", () => {
    // Eleven things the page wants acted on, rendered after a 33 row table
    // with no route to them, is a list nobody reaches. Lines makes the same
    // idea an Attention tab; so does this page.
    const app = read("./App.vue");
    expect(app).toMatch(/const LENSES[^\n]*"attention"/);
    expect(app).toMatch(/<PcLensTab value="attention"/);
  });

  it("prints every absolute instant as UTC with the zone marked", () => {
    // time.ts fixes the contract: the proof line, the seen column and the
    // detail cards are one clock. A browser-local date beside a UTC one reads
    // as a different day east of Greenwich.
    for (const name of components()) {
      const source = read(`./components/${name}`);
      expect(source, name).not.toContain("toLocaleString(");
      expect(source, name).not.toContain("toLocaleDateString(");
      expect(source, name).not.toContain("toLocaleTimeString(");
    }
  });

  it("names the verb on the confirmations that gate a real change", () => {
    // "Continue" is the weakest label on the most consequential control on
    // the page. The apply dialog's primary says what it leads to, and the
    // delete question names how many nodes still reference the record.
    const apply = read("./components/ApplyDialog.vue");
    expect(apply).not.toMatch(/>\s*Continue\s*</);
    expect(apply).toMatch(/Create approval/);
    const app = read("./App.vue");
    expect(app).toContain("deleteQuestion(");
  });

  it("keeps the document as the only vertical scroller", () => {
    // No block on the page may cap itself at a height and scroll on its own;
    // the one exception is the body of a fixed modal, which is not on the page
    // and belongs to the chassis.
    const styles = read("./styles.css");
    expect(styles).not.toContain("max-height");
    expect(styles).not.toContain("100vh");
    expect(styles).not.toContain("100dvh");
    expect(styles).not.toContain("overflow-y");
  });

  it("paints no colour of its own", () => {
    // Every colour is a published token or a chassis derivation of one, so the
    // page follows the console's theme and palette without a second design.
    const styles = read("./styles.css");
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toMatch(/\b(rgb|hsl|oklch)\(/);
  });
});
