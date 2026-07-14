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

/** Discrepancy above this (ms) is treated as a seek and snapped immediately. */
export const SNAP_THRESHOLD_MS = 1500;
/** Fraction of a small drift absorbed per report (persistent correction). */
export const SLEW = 0.25;
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
  private baseOffset = 0;
  private userOffsetMs = 0;
  private initialized = false;
  private lastReportPos = 0;
  private lastReportAt = 0;

  private raw(now: number): number {
    const elapsed = this.playing ? (now - this.reportAt) * this.rate : 0;
    return this.posAtReport + elapsed;
  }

  /** Best estimate of current playback position (ms), including user offset. */
  estimate(now: number): number {
    return this.raw(now) + this.baseOffset + this.userOffsetMs;
  }

  /** Ingest a fresh SMTC timeline report. Snaps on seek, else slews gently. */
  update(report: TimelineReport, now: number): void {
    this.rate = report.rate > 0 ? report.rate : 1;

    if (!this.initialized) {
      this.posAtReport = report.positionMs;
      this.reportAt = report.reportedAtMs;
      this.baseOffset = 0;
      this.initialized = true;
      this.lastReportPos = report.positionMs;
      this.lastReportAt = report.reportedAtMs;
      return;
    }

    // How much the REPORTED position moved vs. how much wall time elapsed. A
    // seek shows up as an unexpected jump here; a "stale" report (browsers)
    // shows up as ~zero movement while time passed.
    const expectedDelta = this.playing ? (report.reportedAtMs - this.lastReportAt) * this.rate : 0;
    const actualDelta = report.positionMs - this.lastReportPos;
    const isSeek = Math.abs(actualDelta - expectedDelta) > SNAP_THRESHOLD_MS;

    // Infer playback when the reported position advances on its own.
    if (!this.playing && actualDelta > ACTIVITY_MS) {
      this.setPlaying(true, now);
    }

    if (isSeek) {
      // Hard re-anchor to the new position.
      this.posAtReport = report.positionMs;
      this.reportAt = report.reportedAtMs;
      this.baseOffset = 0;
    } else if (actualDelta !== 0) {
      // Fresh, consistent report: gently correct toward it.
      const reportedNow =
        report.positionMs + (this.playing ? (now - report.reportedAtMs) * this.rate : 0);
      const diff = reportedNow - (this.raw(now) + this.baseOffset);
      this.baseOffset += diff * SLEW;
    }
    // else: stale report (no positional change) — ignore, keep free-running.

    this.lastReportPos = report.positionMs;
    this.lastReportAt = report.reportedAtMs;
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
