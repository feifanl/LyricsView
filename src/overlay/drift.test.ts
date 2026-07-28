import { describe, expect, it } from "vitest";
import { autoStretchPpm } from "./drift";

describe("autoStretchPpm", () => {
  it("recovers the rate from a genuinely longer release", () => {
    // A 3:00 track against a timeline authored on a 3:04 release: +2.2 %.
    const ppm = autoStretchPpm(180_000, 184_000);
    expect(ppm).toBeCloseTo(22_222, -2);
    // Applied over the whole song it closes the 4 s end-of-track gap.
    expect((180_000 * ppm) / 1_000_000).toBeCloseTo(4_000, -2);
  });

  it("is signed the other way when the source release is shorter", () => {
    expect(autoStretchPpm(180_000, 176_000)).toBeLessThan(0);
  });

  it("ignores a gap the matcher's own tolerance could explain", () => {
    // Every provider path picks its candidate by duration proximity, so a gap
    // this size says nothing about the timeline — acting on it invents drift.
    expect(autoStretchPpm(180_000, 182_000)).toBe(0);
    expect(autoStretchPpm(180_000, 178_000)).toBe(0);
    expect(autoStretchPpm(180_000, 180_300)).toBe(0);
  });

  it("declines the tape-speed case it cannot tell from tolerance", () => {
    // ~600 ms over three minutes is real drift when it happens, but it is
    // indistinguishable from a matcher settling slightly off, so it is left to
    // the manual drift hotkeys rather than guessed at.
    expect(autoStretchPpm(180_000, 180_600)).toBe(0);
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
