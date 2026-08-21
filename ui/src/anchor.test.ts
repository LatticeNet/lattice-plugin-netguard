import { describe, expect, it } from "vitest";

import { anchorTopFrom, clampAnchorTop } from "./anchor";

// These stay DOM-free on purpose: the helpers are duck-typed so the placement
// rules can be tested without jsdom, which is where the frame-is-not-a-viewport
// reasoning actually needs to be pinned down.

function eventAt(top: number): Event {
  return { currentTarget: { getBoundingClientRect: () => ({ top }) } } as unknown as Event;
}

describe("anchorTopFrom", () => {
  it("opens just above the element the operator clicked", () => {
    expect(anchorTopFrom(eventAt(400))).toBe(392);
  });

  it("never opens flush against the document top", () => {
    // A trigger in the first few pixels would otherwise put the overlay under
    // the tab bar.
    expect(anchorTopFrom(eventAt(0))).toBe(12);
    expect(anchorTopFrom(eventAt(-500))).toBe(12);
  });

  it("falls back to the scroll offset when there is no event", () => {
    // Keyboard and programmatic opens have no trigger to measure. Returning 0
    // would drop the overlay at the top of a frame the operator has scrolled
    // far past.
    expect(anchorTopFrom()).toBe(12);
    expect(anchorTopFrom(null)).toBe(12);
    expect(anchorTopFrom({} as Event)).toBe(12);
  });
});

describe("clampAnchorTop", () => {
  it("leaves an anchor that fits alone", () => {
    expect(clampAnchorTop(400, 300, 3400)).toBe(400);
  });

  it("pulls a tall overlay up so it ends inside the document", () => {
    // The case a long fleet creates: apply clicked near the bottom of a 3400px
    // page with a 900px diff dialog.
    expect(clampAnchorTop(3300, 900, 3400)).toBe(2488);
  });

  it("never returns less than the minimum, even when the overlay exceeds the document", () => {
    expect(clampAnchorTop(2000, 5000, 1000)).toBe(12);
    expect(clampAnchorTop(-40, 0, 3400)).toBe(12);
  });

  it("treats a zero-height overlay as unmeasured rather than clamping to the end", () => {
    expect(clampAnchorTop(500, 0, 3400)).toBe(500);
  });
});
