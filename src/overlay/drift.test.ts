import { describe, expect, it } from "vitest";
import { autoStretchPpm } from "./drift";

describe("autoStretchPpm", () => {
  it("recovers the rate from a tape-speed difference", () => {
    // A 3:00 master timed against a 3:00.6 remaster: +0.33 %.
    const ppm = autoStretchPpm(180_000, 180_600);
    expect(ppm).toBeCloseTo(3333, -1);
    // Applied over the whole song it closes the ~600 ms end-of-track gap.
    expect((180_000 * ppm) / 1_000_000).toBeCloseTo(600, 0);
  });

  it("is signed the other way when the source release is shorter", () => {
    expect(autoStretchPpm(180_000, 178_500)).toBeLessThan(0);
  });

  it("ignores differences inside the rounding deadband", () => {
    // Providers report whole seconds; a gap this small is indistinguishable
    // from that rounding, so the correction would be noise.
    expect(autoStretchPpm(180_000, 180_300)).toBe(0);
    expect(autoStretchPpm(180_000, 179_700)).toBe(0);
  });

  it("declines to correct a wildly different release", () => {
    // 12 s apart on a 3-minute song is an edit, not a speed difference.
    expect(autoStretchPpm(180_000, 192_000)).toBe(0);
  });

  it("is a no-op without both durations", () => {
    expect(autoStretchPpm(180_000, undefined)).toBe(0);
    expect(autoStretchPpm(0, 180_000)).toBe(0);
  });

  it("skips clips too short for the ratio to mean anything", () => {
    expect(autoStretchPpm(20_000, 20_500)).toBe(0);
  });
});
