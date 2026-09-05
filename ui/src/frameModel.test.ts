import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

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
