// Two-point sync calibration. Pure logic, unit-tested (calibrate.test.ts).
//
// The nudge hotkeys cannot separate a constant offset from a rate error: one
// scalar, observed at one moment, has two unknowns behind it. Tuning by eye at a
// single point converges on whatever value fixes that instant, which is wrong
// again a verse later.
//
// Two observations at different points in the song fix that. Each mark pairs the
// raw playback position (before any correction — so marks stay valid while the
// correction changes underneath them) with the lyric time that position should
// have mapped to. Least squares over the pairs gives:
//
//   lyricTime = rate * rawAudio + offset
//
// One mark can only move the line that is on screen, so it yields offset alone.
// Rate needs marks far enough apart that the drift between them is larger than
// the user's reaction jitter — hence MIN_SPREAD_MS.

/** A mark: where playback really was, and where the lyrics say it should be. */
export interface SyncMark {
  rawMs: number;
  truthMs: number;
}

export interface Correction {
  stretchPpm: number;
  offsetMs: number;
}

/**
 * Minimum gap between the outer marks before a rate is fitted.
 *
 * Pressing a key "on the line" carries a few hundred ms of reaction error. Over
 * a 20 s span that noise is a ~2% apparent rate error — larger than most real
 * drift, so a fit there would be mostly noise. Over 45 s it is under 1%.
 */
export const MIN_SPREAD_MS = 45_000;

/** Hard bound on the fitted rate. Past ±10% the lyric file is not a stretched
 *  version of this recording, it is a different recording, and no linear
 *  correction will make it fit. Clamping keeps a wild fit from wedging a track. */
export const MAX_STRETCH_PPM = 100_000;

export function clampStretch(ppm: number): number {
  return Math.max(-MAX_STRETCH_PPM, Math.min(MAX_STRETCH_PPM, Math.round(ppm)));
}

/** Widest gap between marks, in raw playback time. */
export function spreadMs(marks: readonly SyncMark[]): number {
  if (marks.length < 2) return 0;
  let lo = marks[0]!.rawMs;
  let hi = marks[0]!.rawMs;
  for (const m of marks) {
    if (m.rawMs < lo) lo = m.rawMs;
    if (m.rawMs > hi) hi = m.rawMs;
  }
  return hi - lo;
}

/**
 * Solve `lyricTime = rate*raw + offset` over the marks.
 *
 * Below MIN_SPREAD_MS (or with a single mark) the rate is left at whatever is
 * already applied and only the offset moves — correcting position without
 * pretending to know a slope the data cannot support.
 */
export function fit(marks: readonly SyncMark[], currentStretchPpm: number): Correction | null {
  if (marks.length === 0) return null;

  if (marks.length === 1 || spreadMs(marks) < MIN_SPREAD_MS) {
    // Offset-only: hold the existing rate and shift so the marks line up under it.
    const rate = 1 + currentStretchPpm / 1_000_000;
    const offset =
      marks.reduce((a, m) => a + (m.truthMs - rate * m.rawMs), 0) / marks.length;
    return { stretchPpm: currentStretchPpm, offsetMs: Math.round(offset) };
  }

  const n = marks.length;
  const mx = marks.reduce((a, m) => a + m.rawMs, 0) / n;
  const my = marks.reduce((a, m) => a + m.truthMs, 0) / n;
  let num = 0;
  let den = 0;
  for (const m of marks) {
    num += (m.rawMs - mx) * (m.truthMs - my);
    den += (m.rawMs - mx) ** 2;
  }
  if (den === 0) return null; // every mark at the same position

  const rate = num / den;
  const stretchPpm = clampStretch((rate - 1) * 1_000_000);
  // Re-derive the offset from the clamped rate, so a clamp cannot leave the
  // pair inconsistent and throw the position off by the amount that was cut.
  const clampedRate = 1 + stretchPpm / 1_000_000;
  const offsetMs = Math.round(
    marks.reduce((a, m) => a + (m.truthMs - clampedRate * m.rawMs), 0) / n,
  );
  return { stretchPpm, offsetMs };
}

/** Largest distance any mark sits from the fitted line, in ms. A real rate error
 *  leaves every mark near the line; a mishandled pause or a misidentified line
 *  leaves one far off. Callers use this to warn rather than silently fit junk. */
export function worstResidualMs(marks: readonly SyncMark[], c: Correction): number {
  const rate = 1 + c.stretchPpm / 1_000_000;
  let worst = 0;
  for (const m of marks) {
    const resid = Math.abs(m.truthMs - (rate * m.rawMs + c.offsetMs));
    if (resid > worst) worst = resid;
  }
  return worst;
}
