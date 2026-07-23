import { describe, expect, it } from "vitest";
import { latestIsoTimestamp } from "@/lib/latestTimestamp";

describe("latestIsoTimestamp", () => {
  it("returns the most recent valid timestamp", () => {
    expect(latestIsoTimestamp([
      "2026-07-14T10:00:00-03:00",
      "2026-07-14T14:30:00Z",
    ])).toBe("2026-07-14T14:30:00.000Z");
  });

  it("ignores empty and invalid timestamp values", () => {
    expect(latestIsoTimestamp([null, undefined, "invalid", "2026-07-14T12:00:00Z"]))
      .toBe("2026-07-14T12:00:00.000Z");
  });

  it("returns null when no valid timestamp exists", () => {
    expect(latestIsoTimestamp([null, undefined, "invalid"])).toBeNull();
  });
});
