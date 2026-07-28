// Automatic per-track drift correction. Pure logic, unit-tested (drift.test.ts).
//
// A lyric timeline is timed against one specific release. Play a different one
// and the timeline runs at the wrong rate: analog-era masters and their digital
// remasters differ in tape speed by a fraction of a percent, which is invisible
// at the first line and a second or more off by the last. Providers report the
// duration of the release they timed against, so the ratio against the playing
// track's own duration recovers that rate directly:
//
//   rate = sourceDuration / trackDuration   (ppm = (rate - 1) * 1e6)
//
// which is exactly the `stretchPpm` the overlay already applies by hand.

/** Below this, a track is too short for the ratio to be meaningful. */
const MIN_DURATION_MS = 30_000;
/** Provider durations are rounded to whole seconds, so an observed gap carries
 *  up to ±500 ms of rounding noise. That's the floor worth acting on: below it
 *  the correction is smaller than its own error bar, above it correcting is a
 *  win in expectation even though a rounding-sized residual always remains.
 *  Note this is deliberately *not* set higher — real tape-speed drift is only
 *  ~600 ms over a 3-minute song, which is exactly the case being corrected. */
const DEADBAND_MS = 500;
/** Beyond ±3 % the releases differ by more than speed — a different edit, a
 *  live cut, a bonus-track version. A linear stretch is the wrong model there,
 *  so correct nothing rather than making it worse. */
const MAX_PPM = 30_000;

/**
 * Drift correction implied by the duration gap, in parts-per-million.
 * Returns 0 whenever the ratio isn't trustworthy enough to act on.
 */
export function autoStretchPpm(trackDurationMs: number, sourceDurationMs?: number): number {
  if (!sourceDurationMs || !trackDurationMs) return 0;
  if (trackDurationMs < MIN_DURATION_MS || sourceDurationMs < MIN_DURATION_MS) return 0;
  if (Math.abs(sourceDurationMs - trackDurationMs) < DEADBAND_MS) return 0;

  const ppm = Math.round((sourceDurationMs / trackDurationMs - 1) * 1_000_000);
  return Math.abs(ppm) > MAX_PPM ? 0 : ppm;
}
