// Interpolated playback clock. Pure logic, unit-tested (clock.test.ts).
//
//   estimate(now) = reportedPos + (playing ? (now - reportedAt) * rate : 0)
//                   + smoothingCorrection + userOffset
//
// SMTC position reports are coarse and stale, so we never drive the renderer
// straight from them. On each report we either SNAP (large discrepancy => the
// user seeked) or absorb a small error into a correction term that decays
// exponentially, so the highlight glides instead of jumping.

/** Discrepancy above this (ms) is treated as a seek and snapped immediately. */
export const SNAP_THRESHOLD_MS = 1500;
/** Exponential time constant for blending out small corrections (~500 ms settle). */
export const CORRECTION_TAU_MS = 250;

export interface TimelineReport {
  positionMs: number;
  reportedAtMs: number;
  rate: number;
}

export class PlaybackClock {
  private posAtReport = 0;
  private reportAt = 0;
  private rate = 1;
  private playing = false;
  private corr0 = 0;
  private corrAt = 0;
  private userOffsetMs = 0;
  private initialized = false;

  /** Raw extrapolation from the last report, no correction/offset. */
  private raw(now: number): number {
    const elapsed = this.playing ? (now - this.reportAt) * this.rate : 0;
    return this.posAtReport + elapsed;
  }

  private correction(now: number): number {
    if (this.corr0 === 0) return 0;
    return this.corr0 * Math.exp(-(now - this.corrAt) / CORRECTION_TAU_MS);
  }

  /** Best estimate of current playback position (ms), including user offset. */
  estimate(now: number): number {
    return this.raw(now) + this.correction(now) + this.userOffsetMs;
  }

  /** Ingest a fresh SMTC timeline report. Snaps on seek, else slews smoothly. */
  update(report: TimelineReport, now: number): void {
    const displayedSansUser = this.initialized ? this.raw(now) + this.correction(now) : null;

    this.posAtReport = report.positionMs;
    this.reportAt = report.reportedAtMs;
    this.rate = report.rate > 0 ? report.rate : 1;

    const newRaw = this.raw(now);
    if (displayedSansUser === null) {
      this.corr0 = 0; // first report: snap
    } else {
      const rawError = newRaw - displayedSansUser;
      // Snap on big jumps (seek); otherwise keep the displayed value continuous
      // by seeding a correction that then decays to zero.
      this.corr0 = Math.abs(rawError) > SNAP_THRESHOLD_MS ? 0 : -rawError;
    }
    this.corrAt = now;
    this.initialized = true;
  }

  /** Toggle play/pause without jumping: rebase onto the current estimate. */
  setPlaying(playing: boolean, now: number): void {
    if (playing === this.playing) return;
    this.posAtReport = this.raw(now);
    this.reportAt = now;
    this.playing = playing;
  }

  setUserOffset(offsetMs: number): void {
    this.userOffsetMs = offsetMs;
  }

  getUserOffset(): number {
    return this.userOffsetMs;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
