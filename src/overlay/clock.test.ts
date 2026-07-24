import { describe, expect, it } from "vitest";
import { PlaybackClock } from "./clock";

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
    expect(c.estimate(3000)).toBeCloseTo(5000, 0);
  });

  it("applies user offset", () => {
    const c = playingClock(10_000, 1000);
    c.setUserOffset(500);
    expect(c.estimate(1000)).toBeCloseTo(10_500, 0);
  });

  it("keeps advancing when the player reports a STALE position (browser trap)", () => {
    // Player reports the same position every second while audio really plays.
    const c = playingClock(10_000, 1000);
    for (let t = 2000; t <= 6000; t += 1000) {
      c.update({ positionMs: 10_000, reportedAtMs: t, rate: 1 }, t);
    }
    // Despite stale reports, the estimate has advanced well past 10 s.
    expect(c.estimate(6000)).toBeGreaterThan(13_000);
  });

  it("infers playback from advancing reports even if setPlaying was never called", () => {
    const c = new PlaybackClock();
    c.update({ positionMs: 0, reportedAtMs: 0, rate: 1 }, 0);
    // Never called setPlaying(true), but positions advance ~1s apart.
    c.update({ positionMs: 1000, reportedAtMs: 1000, rate: 1 }, 1000);
    c.update({ positionMs: 2000, reportedAtMs: 2000, rate: 1 }, 2000);
    expect(c.isPlaying()).toBe(true);
    expect(c.estimate(3000)).toBeGreaterThan(2000); // advancing, not frozen
  });

  it("snaps on a large discrepancy (seek)", () => {
    const c = playingClock(10_000, 1000);
    c.update({ positionMs: 40_000, reportedAtMs: 2000, rate: 1 }, 2000);
    expect(c.estimate(2000)).toBeCloseTo(40_000, -1);
  });

  it("re-anchors to a fresh report (accurate, no persistent lag)", () => {
    const c = playingClock(10_000, 1000);
    // A fresh tick: position advanced to 11_300, sampled at t=2000.
    c.update({ positionMs: 11_300, reportedAtMs: 2000, rate: 1 }, 2000);
    expect(c.estimate(2000)).toBeCloseTo(11_300, 0);
    expect(c.estimate(3000)).toBeCloseTo(12_300, 0);
  });

  it("follows a backward seek (re-anchors on any position change)", () => {
    const c = playingClock(60_000, 1000);
    // User seeks back to 5 s; player reports the new position at t=2000.
    c.update({ positionMs: 5000, reportedAtMs: 2000, rate: 1 }, 2000);
    expect(c.estimate(2000)).toBeCloseTo(5000, -1);
    expect(c.estimate(3000)).toBeCloseTo(6000, -1);
  });

  it("reset() clears prior state so a new song starts at zero", () => {
    const c = playingClock(120_000, 1000);
    expect(c.estimate(5000)).toBeGreaterThan(100_000);
    c.reset();
    expect(c.isPlaying()).toBe(false);
    expect(c.estimate(9999)).toBe(0);
    // First report of the new song anchors fresh.
    c.setPlaying(true, 10_000);
    c.update({ positionMs: 0, reportedAtMs: 10_000, rate: 1 }, 10_000);
    expect(c.estimate(11_000)).toBeCloseTo(1000, 0);
  });

  it("keeps the sample time when play is confirmed after the first report", () => {
    // Track-start order (poll emits timeline before playback-state): the first
    // report is anchored while still 'paused', then playback-state confirms
    // playing. Its position was sampled at t=0 but processed 5 s later; the
    // estimate must reflect that 5 s of elapsed audio, not restart from 0.
    const c = new PlaybackClock();
    c.update({ positionMs: 0, reportedAtMs: 0, rate: 1 }, 5000);
    c.setPlaying(true, 5000);
    expect(c.estimate(5000)).toBeCloseTo(5000, 0); // not 0 (late by 5 s)
    expect(c.estimate(6000)).toBeCloseTo(6000, 0);
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
