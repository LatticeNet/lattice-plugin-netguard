import { describe, expect, it } from "vitest";

import { ageLabel, clockUtc, stampUtc } from "./time";

const now = Date.parse("2026-09-02T03:52:51Z");

describe("time labels", () => {
  it("renders an age at every scale and never negative", () => {
    expect(ageLabel("2026-09-02T03:52:10Z", now)).toBe("41s");
    expect(ageLabel("2026-09-02T03:40:00Z", now)).toBe("13m");
    expect(ageLabel("2026-09-02T00:52:51Z", now)).toBe("3h");
    expect(ageLabel("2026-08-30T14:02:00Z", now)).toBe("3d");
    // A clock ahead of the server's is not a negative age.
    expect(ageLabel("2026-09-02T03:53:51Z", now)).toBe("0s");
    expect(ageLabel(undefined, now)).toBe("?");
    expect(ageLabel("soon", now)).toBe("?");
  });

  it("writes absolute times in UTC with the zone marked", () => {
    expect(clockUtc("2026-09-02T03:52:10Z")).toBe("03:52:10Z");
    expect(clockUtc(now)).toBe("03:52:51Z");
    expect(stampUtc("2026-09-02T03:52:10+02:00")).toBe("2026-09-02 01:52Z");
    expect(stampUtc(undefined)).toBe("");
  });
});
