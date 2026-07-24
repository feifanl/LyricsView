// Interpolated playback clock. Pure logic, unit-tested (clock.test.ts).
//
//   estimate(now) = posAtReport + (playing ? (now - reportAt) * rate : 0)
//                   + baseOffset + userOffset
//
// SMTC position reports are coarse and STALE — several players (Spotify, and
// browsers playing YouTube Music) do not advance the reported timeline during
// normal playback, only on seek/pause. So we must NOT re-anchor to every report:
// we free-run from the first anchor and only nudge a small persistent
// `baseOffset` toward each report (or hard-snap on a seek). We also infer
// "playing" from timeline advancement, since browser playback-state can be
// unreliable.

/** Position advance (ms) between reports that implies active playback. */
const ACTIVITY_MS = 250;

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
  private userOffsetMs = 0;
  private initialized = false;
  private lastReportPos = 0;
  private updates = 0;
  private sawPause = false; // did we observe a real pause since the last resume?

  private raw(now: number): number {
    const elapsed = this.playing ? (now - this.reportAt) * this.rate : 0;
    return this.posAtReport + elapsed;
  }

  /** Best estimate of current playback position (ms), including user offset. */
  estimate(now: number): number {
    return this.raw(now) + this.userOffsetMs;
  }

  /**
   * Ingest a fresh SMTC timeline report. A report whose position moved since the
   * last one is ground truth — re-anchor to it (its timestamp is the sample
   * time, so extrapolation to `now` is accurate). A "stale" report (unchanged
   * position while time passed — the browser/Spotify trap) carries no new info,
   * so we ignore it and keep free-running.
   */
  update(report: TimelineReport, now: number): void {
    this.rate = report.rate > 0 ? report.rate : 1;
    this.updates += 1;

    if (!this.initialized) {
      this.anchor(report);
      this.initialized = true;
      this.lastReportPos = report.positionMs;
      return;
    }

    const advanced = report.positionMs - this.lastReportPos;
    if (!this.playing && advanced > ACTIVITY_MS) {
      this.setPlaying(true, now);
    }
    if (advanced !== 0) {
      this.anchor(report); // real movement (fresh tick or seek) → trust it
    }
    this.lastReportPos = report.positionMs;
  }

  private anchor(report: TimelineReport): void {
    this.posAtReport = report.positionMs;
    this.reportAt = report.reportedAtMs;
  }

  /** Clear all state (call on track change so a new song starts from zero and
   *  never inherits the previous song's anchor/position). */
  reset(): void {
    this.initialized = false;
    this.playing = false;
    this.posAtReport = 0;
    this.reportAt = 0;
    this.lastReportPos = 0;
    this.updates = 0;
    this.sawPause = false;
  }

  /** True once we've had more than one report since the last reset, so the
   *  anchor is no longer just the (often stale) first post-track-change report.
   *  Callers gate rendering on this to avoid flashing a wrong line at song start. */
  hasSettled(): boolean {
    return this.updates >= 2;
  }

  /**
   * Toggle play/pause. Pause freezes at the current estimate. Resume normally
   * rebases onto that frozen estimate at `now` so the paused gap isn't counted —
   * but the FIRST play-confirmation of an already-moving track is not a resume:
   * the current anchor's `reportAt` is a real sample time, and rebasing it to
   * `now` would drop the sample's staleness and run the highlight late. So we
   * only rebase when we actually observed a pause (or before the first anchor).
   */
  setPlaying(playing: boolean, now: number): void {
    if (playing === this.playing) return;
    if (playing) {
      if (this.sawPause || !this.initialized) {
        this.posAtReport = this.raw(now);
        this.reportAt = now;
      }
      this.sawPause = false;
    } else {
      this.posAtReport = this.raw(now);
      this.reportAt = now;
      this.sawPause = true;
    }
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
