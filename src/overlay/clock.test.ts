import { describe, expect, it } from "vitest";
import { PlaybackClock, SNAP_THRESHOLD_MS } from "./clock";

function playingClock(startPos = 0, at = 1000): PlaybackClock {
  const c = new PlaybackClock();
  c.setPlaying(true, at);
  c.update({ positionMs: startPos, reportedAtMs: at, rate: 1 }, at);
  return c;
}

describe("PlaybackClock", () => {
  it("extrapolates linearly while playing", () => {
    const c = playingClock(10_000, 1000);
    expect(c.estimate(1000)).toBeCloseTo(10_000, 0);
    expect(c.estimate(2000)).toBeCloseTo(11_000, 0);
  });

  it("freezes while paused", () => {
    const c = new PlaybackClock();
    c.update({ positionMs: 5000, reportedAtMs: 0, rate: 1 }, 0);
    // never marked playing -> frozen
    expect(c.estimate(3000)).toBeCloseTo(5000, 0);
  });

  it("applies user offset", () => {
    const c = playingClock(10_000, 1000);
    c.setUserOffset(500);
    expect(c.estimate(1000)).toBeCloseTo(10_500, 0);
  });

  it("snaps on a large discrepancy (seek)", () => {
    const c = playingClock(10_000, 1000);
    // At t=2000 estimate ~11_000. A report of 40_000 is a seek -> snap.
    c.update({ positionMs: 40_000, reportedAtMs: 2000, rate: 1 }, 2000);
    expect(c.estimate(2000)).toBeCloseTo(40_000, -1);
  });

  it("slews smoothly on a small discrepancy (no visible jump)", () => {
    const c = playingClock(10_000, 1000);
    // At t=2000 estimate ~11_000. Report 11_300 (300ms drift, < snap).
    const before = c.estimate(2000);
    c.update({ positionMs: 11_300, reportedAtMs: 2000, rate: 1 }, 2000);
    const justAfter = c.estimate(2000);
    // No instantaneous jump: displayed value stays continuous.
    expect(justAfter).toBeCloseTo(before, 0);
    // The drift is below the snap threshold.
    expect(Math.abs(11_300 - before)).toBeLessThan(SNAP_THRESHOLD_MS);
    // After the correction decays, it converges to the reported truth.
    const settled = c.estimate(2000 + 2000);
    expect(settled).toBeCloseTo(11_300 + 2000, -1);
  });

  it("does not jump when toggling pause/play", () => {
    const c = playingClock(10_000, 1000);
    const at = 5000;
    const before = c.estimate(at);
    c.setPlaying(false, at);
    expect(c.estimate(at)).toBeCloseTo(before, 0);
    c.setPlaying(true, at);
    expect(c.estimate(at)).toBeCloseTo(before, 0);
  });
});
