import { describe, expect, it } from "vitest";

import { stateTone } from "./tones";

describe("stateTone", () => {
  it("reads the server's four tones onto the chassis vocabulary", () => {
    expect(stateTone("ok")).toBe("healthy");
    expect(stateTone("warn")).toBe("warning");
    expect(stateTone("danger")).toBe("error");
    expect(stateTone("muted")).toBe("neutral");
  });

  it("never paints an unknown word as healthy", () => {
    expect(stateTone("")).toBe("neutral");
    expect(stateTone("drift_detected")).toBe("neutral");
  });
});
