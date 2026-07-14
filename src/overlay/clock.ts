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
