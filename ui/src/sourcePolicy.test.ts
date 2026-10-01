/**
 * What the page must not do anywhere in its source, checked as a lint over
 * every module rather than as a claim about one file. These are absence
 * checks on purpose. What the page does is covered by the model tests, the
 * rendered components (render.test.ts) and the rendered pages at 1440 and
 * 375; a test that a string is present passes on dead code and fails on a
 * harmless rename.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));

function sources(prefix = ""): string[] {
  return readdirSync(`${root}${prefix}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    return /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const styles = () => read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("netguard source policy", () => {
  it("reports no height to the host", () => {
    // The host frame is a viewport it sizes itself and it ignores the
    // reported number. Measuring the document to say how tall it is costs a
    // full synchronous layout on every body resize and buys nothing.
    for (const path of sources()) {
      const source = read(path);
      expect(source, path).not.toContain("ResizeObserver");
      expect(source, path).not.toMatch(/bridge\??\.resize\(/);
    }
  });

  it("reads data only when asked: the one interval is the age clock", () => {
    // A background reload re-sorts the fleet and moves rows under the
    // pointer, and in a panel whose rows open a node and whose buttons apply
    // a firewall that is how the wrong node gets clicked. clock.ts ticks the
    // relative ages, reads nothing, and stops while the page is hidden
    // (clock.test.ts).
    const timed = sources().filter((path) => read(path).includes("setInterval("));
    expect(timed).toEqual(["clock.ts"]);
  });

  it("prints no browser-local date or time", () => {
    // time.ts fixes the contract: every absolute instant is UTC with the zone
    // marked. A browser-local date beside a UTC one reads as a different day
    // east of Greenwich.
    for (const path of sources()) {
      expect(read(path), path).not.toMatch(/toLocale(Date|Time)?String\(/);
    }
  });

  it("measures no layout to place a dialog", () => {
    // Overlays are fixed against the frame's window by the chassis; reading
    // geometry to position one is how a modal ended up off screen.
    for (const path of sources().filter((name) => name.startsWith("components/") && /(Dialog|Editor)\.vue$/.test(name))) {
      expect(read(path), path).not.toContain("getBoundingClientRect");
    }
  });

  it("keeps the document as the only vertical scroller", () => {
    // No block on the page caps its height and scrolls on its own; the one
    // exception, a fixed modal's body, belongs to the chassis.
    const css = styles();
    expect(css).not.toContain("max-height");
    expect(css).not.toMatch(/100d?vh/);
    expect(css).not.toContain("overflow-y");
  });

  it("paints no colour of its own", () => {
    // Every colour is a published token or a chassis derivation of one, so
    // the page follows the console's theme and palette without a second design.
    const css = styles();
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|hsl|oklch)\(/);
  });
});
