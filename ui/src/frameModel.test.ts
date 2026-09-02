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

  it("positions overlays against the window, not a measured document anchor", () => {
    const dialog = read("./components/ModalDialog.vue");
    expect(dialog).not.toContain("anchorTop");
    expect(dialog).not.toContain("getBoundingClientRect");
    const styles = read("./styles.css");
    const root = styles.match(/\.overlay-root \{[^}]*\}/)?.[0] ?? "";
    expect(root).toContain("position: fixed");
    expect(root).toContain("inset: 0");
  });

  it("keeps the document as the only vertical scroller", () => {
    // No block on the page may cap itself at a height and scroll on its own;
    // the one exception is the body of a fixed modal, which is not on the page.
    const styles = read("./styles.css");
    for (const selector of [".table-scroll", ".code", ".panel", ".detail", ".subpanel", ".findings"]) {
      const block = styles.match(new RegExp(`\\${selector} \\{[^}]*\\}`))?.[0] ?? "";
      expect(block, selector).not.toContain("max-height");
      expect(block, selector).not.toContain("100vh");
      expect(block, selector).not.toContain("100dvh");
    }
    const tableScroll = styles.match(/\.table-scroll \{[^}]*\}/)?.[0] ?? "";
    expect(tableScroll).not.toContain("overflow-y");
  });
});
