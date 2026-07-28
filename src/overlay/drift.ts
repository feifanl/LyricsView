// Automatic per-track drift correction. Pure logic, unit-tested (drift.test.ts).
//
// A lyric timeline is timed against one specific release. Play a different one
// and the timeline runs at the wrong rate, so the ratio of the two durations
// recovers that rate:
//
//   rate = sourceDuration / trackDuration   (ppm = (rate - 1) * 1e6)
//
// which is exactly the `stretchPpm` the overlay already applies by hand.
//
// The catch is that a duration gap is only evidence when it is bigger than the
// noise it is measured against, and every provider path *selects* its candidate
// by duration proximity: LRCLIB's exact-match endpoint is queried with the
// track's own duration, Musixmatch's matcher takes `q_duration`, and the local
// scorer rewards duration closeness. So a small residual gap is the matcher's
// tolerance, not a property of the timeline — and multiplying it into a rate
// manufactures drift that was never in the lyrics.

/** Below this, a track is too short for the ratio to be meaningful. */
const MIN_DURATION_MS = 30_000;
/** How far apart the durations must be before the gap counts as evidence.
 *
 *  Set above the matching tolerance that produced the candidate in the first
 *  place (a couple of seconds), not at the rounding floor. The cost is real:
 *  genuine tape-speed drift between an analog master and its remaster is only
 *  ~600 ms over a three-minute song, so this rules out the very case the ratio
 *  was meant to catch. It has to. Nothing in the metadata distinguishes that
 *  600 ms from a matcher that settled two seconds off, and guessing wrong adds
 *  drift to lyrics that were correctly timed. Only a gap too large to be
 *  tolerance — a genuinely different-length release — is acted on; everything
 *  finer is left to the manual drift hotkeys, where the user can see the
 *  result. */
const MIN_EVIDENCE_MS = 3_000;
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
  if (Math.abs(sourceDurationMs - trackDurationMs) < MIN_EVIDENCE_MS) return 0;

  const ppm = Math.round((sourceDurationMs / trackDurationMs - 1) * 1_000_000);
  return Math.abs(ppm) > MAX_PPM ? 0 : ppm;
}
