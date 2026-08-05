import { describe, expect, it } from "vitest";
import {
  MAX_STRETCH_PPM,
  clampStretch,
  fit,
  spreadMs,
  worstResidualMs,
} from "./calibrate";

describe("clampStretch", () => {
  it("bounds runaway values in both directions", () => {
    expect(clampStretch(5_000_000)).toBe(MAX_STRETCH_PPM);
    expect(clampStretch(-5_000_000)).toBe(-MAX_STRETCH_PPM);
    expect(clampStretch(2500)).toBe(2500);
  });
});

describe("spreadMs", () => {
  it("is zero below two marks", () => {
    expect(spreadMs([])).toBe(0);
    expect(spreadMs([{ rawMs: 1000, truthMs: 1000 }])).toBe(0);
  });

  it("measures the widest gap regardless of order", () => {
    const marks = [
      { rawMs: 90_000, truthMs: 90_000 },
      { rawMs: 10_000, truthMs: 10_000 },
      { rawMs: 50_000, truthMs: 50_000 },
    ];
    expect(spreadMs(marks)).toBe(80_000);
  });
});

describe("fit", () => {
  it("returns null with no marks", () => {
    expect(fit([], 0)).toBeNull();
  });

  it("moves offset only from a single mark, holding the current rate", () => {
    const c = fit([{ rawMs: 40_000, truthMs: 38_000 }], 0)!;
    expect(c.stretchPpm).toBe(0);
    expect(c.offsetMs).toBe(-2000);
  });

  it("keeps an already-applied rate when solving offset alone", () => {
    // rate 1.01 -> 40 000 raw maps to 40 400 before offset; truth is 38 000.
    const c = fit([{ rawMs: 40_000, truthMs: 38_000 }], 10_000)!;
    expect(c.stretchPpm).toBe(10_000);
    expect(c.offsetMs).toBe(-2400);
  });

  it("refuses a rate when the marks are too close together", () => {
    const marks = [
      { rawMs: 40_000, truthMs: 38_000 },
      { rawMs: 60_000, truthMs: 57_000 }, // 20 s apart, under MIN_SPREAD_MS
    ];
    expect(fit(marks, 0)!.stretchPpm).toBe(0);
  });

  it("recovers a known rate and offset from two far-apart marks", () => {
    // truth = 0.9673*raw - 1128, the 500 Miles case.
    const rate = 0.9673;
    const offset = -1128;
    const marks = [40_000, 152_000].map((rawMs) => ({
      rawMs,
      truthMs: rate * rawMs + offset,
    }));
    const c = fit(marks, 0)!;
    expect(c.stretchPpm).toBeCloseTo(-32_700, -2);
    expect(c.offsetMs).toBeCloseTo(offset, -1);
  });

  it("clamps an absurd fit and keeps the offset consistent with the clamp", () => {
    const marks = [
      { rawMs: 10_000, truthMs: 10_000 },
      { rawMs: 60_000, truthMs: 300_000 }, // ~380% rate
    ];
    const c = fit(marks, 0)!;
    expect(c.stretchPpm).toBe(MAX_STRETCH_PPM);
    // Offset re-derived from the clamped rate, not the raw one.
    const rate = 1 + MAX_STRETCH_PPM / 1_000_000;
    const expected = Math.round((10_000 - rate * 10_000 + (300_000 - rate * 60_000)) / 2);
    expect(c.offsetMs).toBe(expected);
  });

  it("averages out reaction jitter across three marks", () => {
    const marks = [
      { rawMs: 30_000, truthMs: 30_100 },
      { rawMs: 90_000, truthMs: 89_900 },
      { rawMs: 150_000, truthMs: 150_100 },
    ];
    const c = fit(marks, 0)!;
    expect(Math.abs(c.stretchPpm)).toBeLessThan(2000); // no real drift here
  });
});

describe("worstResidualMs", () => {
  it("is near zero when marks lie on the fitted line", () => {
    const marks = [
      { rawMs: 30_000, truthMs: 29_000 },
      { rawMs: 150_000, truthMs: 145_000 },
    ];
    const c = fit(marks, 0)!;
    expect(worstResidualMs(marks, c)).toBeLessThan(2);
  });

  it("exposes a step as a large residual", () => {
    // Two marks aligned, a third shifted bodily by a missed pause.
    const marks = [
      { rawMs: 30_000, truthMs: 30_000 },
      { rawMs: 90_000, truthMs: 90_000 },
      { rawMs: 150_000, truthMs: 144_000 },
    ];
    const c = fit(marks, 0)!;
    expect(worstResidualMs(marks, c)).toBeGreaterThan(1000);
  });
});
