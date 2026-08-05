// Dev-only sync diagnostic. Answers one question: when the highlight drifts,
// is it our clock losing the audio, or is the lyric file's timeline simply not
// this recording's timeline?
//
// Every call site in main.ts is guarded by `import.meta.env.DEV`, so this module
// is tree-shaken out of production builds and `window.__diag` exists only in
// `npm run tauri dev`.
//
// Two independent measurements, neither of which needs the other:
//
//   1. Clock health — every SMTC report whose position actually moved is ground
//      truth from the player. Comparing the position delta against the wall-clock
//      delta between two such reports gives the player's playback rate as we see
//      it. Locked to real time (|ppm| small) means our clock is fine and any
//      drift is in the lyric timeline. Reports that never advance mean we are
//      free-running blind, which is itself the finding.
//
//   2. Alignment truth — needs an ear. Call mark(i) while line i is being sung;
//      that pairs our raw position with the line's real start. Three marks are
//      the minimum that can tell a real rate error from a single step.
//
// Console entry point is `__diag`.

interface RateSample {
  /** Player position at the report (ms). */
  posMs: number;
  /** Position advance since the previous advancing report (ms). */
  dPosMs: number;
  /** Wall-clock advance over the same span (ms). */
  dWallMs: number;
  /** PlaybackRate the player reported alongside this position. */
  rate: number;
}

/** Wall-clock span the advancing reports must cover before a rate fit means
 *  anything. Two reports 100 ms apart, with position quantized to whole
 *  seconds, produce a "rate error" of tens of percent out of pure rounding. */
const MIN_RATE_SPAN_MS = 30_000;

/** Marks needed before a rate fit is worth believing. Two marks fit a straight
 *  line through anything — a genuine 1%-per-minute stretch and a single missed
 *  pause produce identical two-point data. Three or more expose the difference
 *  as residuals: a real stretch stays on the line, a step does not. */
const MIN_MARKS_FOR_RATE = 3;

interface Mark {
  /** Our clock's position, before stretch and offset are applied (ms). */
  rawMs: number;
  /** Where the lyric file says that line starts (ms). */
  truthMs: number;
  lineIdx: number;
  text: string;
  /** Pause/resume transitions seen before this mark — a pause between two marks
   *  is enough to fake drift, so the fit has to be able to say it happened. */
  pauseCount: number;
}

const rates: RateSample[] = [];
const marks: Mark[] = [];
let lastPos = -1;
let lastWall = -1;
let staleReports = 0;
let pauseCount = 0;
/** Set when playback stops, cleared once the next report has been consumed, so
 *  the interval bridging the pause is never counted as playing time. */
let pausedSinceLastReport = false;

/** Hooks into the overlay's state, injected by main.ts so this file stays
 *  standalone and can be deleted in one piece. */
export interface DiagHost {
  /** Clock position with user offset and stretch removed. */
  rawPos(): number;
  /** Position actually used for rendering. */
  renderPos(): number;
  lines(): { start: number; text: string }[];
  applyCorrection(stretchPpm: number, offsetMs: number): void;
}

let host: DiagHost | null = null;

/** Record an SMTC report. Call before clock.update so the report is still
 *  untouched ground truth. */
export function noteReport(positionMs: number, reportedAtMs: number, rate: number): void {
  if (positionMs === lastPos) {
    staleReports += 1;
    return;
  }
  if (lastPos >= 0 && positionMs > lastPos && !pausedSinceLastReport) {
    const dPos = positionMs - lastPos;
    const dWall = reportedAtMs - lastWall;
    // Ignore seeks and track changes: a jump far larger than the wall-clock
    // gap is not playback, and a rate fit would be meaningless.
    if (dWall > 0 && dPos < dWall * 4) {
      rates.push({ posMs: positionMs, dPosMs: dPos, dWallMs: dWall, rate });
    }
  }
  pausedSinceLastReport = false;
  lastPos = positionMs;
  lastWall = reportedAtMs;
}

/** Playback started or stopped. Wall clock keeps running while paused but the
 *  position does not, so any interval spanning a pause would read as the player
 *  losing tens of percent against real time — which is exactly the bogus verdict
 *  this guards against. */
export function notePlaying(playing: boolean): void {
  pauseCount += 1;
  if (!playing) pausedSinceLastReport = true;
}

export function reset(): void {
  rates.length = 0;
  marks.length = 0;
  lastPos = -1;
  lastWall = -1;
  staleReports = 0;
  pauseCount = 0;
  pausedSinceLastReport = false;
}

function fmt(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** Print the lyric timeline with indices, so mark() has something to name. */
function showLines(): void {
  const ls = host?.lines() ?? [];
  if (ls.length === 0) {
    console.log("[diag] no lyrics loaded");
    return;
  }
  const pos = host!.renderPos();
  console.table(
    ls.map((l, i) => ({
      i,
      start: fmt(l.start),
      showing: l.start <= pos && (ls[i + 1]?.start ?? Infinity) > pos ? "◀" : "",
      text: l.text.slice(0, 48),
    })),
  );
}

/** Call while line `i` is actually being sung. */
function mark(i: number): void {
  const ls = host?.lines() ?? [];
  const line = ls[i];
  if (!line) {
    console.log(`[diag] no line ${i} (have 0..${ls.length - 1})`);
    return;
  }
  const rawMs = host!.rawPos();
  marks.push({ rawMs, truthMs: line.start, lineIdx: i, text: line.text, pauseCount });
  const err = host!.renderPos() - line.start;
  console.log(
    `[diag] mark #${marks.length}: at ${fmt(rawMs)} you say line ${i} (${fmt(line.start)}) — ` +
      `showing ${err >= 0 ? "+" : ""}${(err / 1000).toFixed(2)}s ${err >= 0 ? "ahead" : "behind"}`,
  );
}

/** Least-squares fit of truth = rate*raw + offset over the marks. */
function fit(): { stretchPpm: number; offsetMs: number } | null {
  if (marks.length < 2) {
    console.log("[diag] need at least 2 marks, ideally far apart in the song");
    return null;
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
  if (den === 0) {
    console.log("[diag] marks are all at the same position — spread them out");
    return null;
  }
  const rate = num / den;
  const offsetMs = my - rate * mx;
  const stretchPpm = Math.round((rate - 1) * 1_000_000);
  const spread = Math.max(...marks.map((m) => m.rawMs)) - Math.min(...marks.map((m) => m.rawMs));
  console.log(
    `[diag] fit over ${n} marks spanning ${(spread / 1000).toFixed(0)}s: ` +
      `stretch ${stretchPpm >= 0 ? "+" : ""}${stretchPpm} ppm (${(stretchPpm / 10_000).toFixed(2)}%), ` +
      `offset ${Math.round(offsetMs)} ms`,
  );
  if (spread < 60_000) console.log("[diag] ⚠ marks span < 60s — rate estimate is shaky");

  // A pause the clock mishandled shifts every later mark by the same amount,
  // which two marks cannot tell apart from a stretch. Say so rather than
  // quietly reporting drift that may be a step.
  const paused = marks[n - 1]!.pauseCount > marks[0]!.pauseCount;
  if (paused) {
    console.log(
      "[diag] ⚠ playback stopped and started between marks — a mishandled pause " +
        "shifts later marks bodily and reads as stretch. Re-measure without pausing.",
    );
  }
  if (n < MIN_MARKS_FOR_RATE) {
    console.log(
      `[diag] ⚠ only ${n} marks: a straight line fits any two points, so this cannot ` +
        `distinguish a real stretch from one step. Add a third, mid-song.`,
    );
  } else {
    // Residuals are the tell: a genuine constant stretch leaves everything near
    // the line, a step leaves marks on either side of it grouped and far off.
    const resid = marks.map((m) => m.truthMs - (rate * m.rawMs + offsetMs));
    const worst = Math.max(...resid.map(Math.abs));
    console.log(
      `[diag] residuals (ms): ${resid.map((r) => Math.round(r)).join(", ")} — worst ${Math.round(worst)}`,
    );
    // 500 ms, not tighter: hitting Enter on a sung line carries a few hundred ms
    // of reaction jitter, and calling that a step would be a false alarm.
    console.log(
      worst < 500
        ? "[diag] → marks lie on a line: the drift really is a constant rate error."
        : "[diag] → marks do NOT lie on a line: this is a step (missed pause/seek), not a stretch.",
    );
  }
  return { stretchPpm, offsetMs: Math.round(offsetMs) };
}

/** Fit, then push the result into the live track's correction. */
function apply(): void {
  const f = fit();
  if (f) host?.applyCorrection(f.stretchPpm, f.offsetMs);
}

/** Clock verdict: is our position estimate keeping up with the player? */
function summary(): void {
  console.log(
    `[diag] advancing reports: ${rates.length}, stale reports: ${staleReports}, ` +
      `play/pause transitions: ${pauseCount}`,
  );
  const totalPos = rates.reduce((a, r) => a + r.dPosMs, 0);
  const totalWall = rates.reduce((a, r) => a + r.dWallMs, 0);
  const reportedRates = [...new Set(rates.map((r) => r.rate))];

  if (totalWall < MIN_RATE_SPAN_MS) {
    // Not a measurement — say so instead of fitting noise. A player that only
    // republishes its position on seek/pause leaves us free-running from one
    // anchor, and then the only rate we ever apply is the reported PlaybackRate.
    console.log(
      `[diag] advancing reports span only ${(totalWall / 1000).toFixed(1)}s of wall clock — ` +
        "too little to measure rate. The player is not republishing its position, " +
        "so we free-run from a single anchor for the whole song.",
    );
    console.log(
      `[diag] → free-running position can only gain or lose time via the reported ` +
        `PlaybackRate, which was ${reportedRates.length ? reportedRates.join(", ") : "never seen"}. ` +
        (reportedRates.every((r) => r === 1)
          ? "At exactly 1.0 our clock cannot stretch time, so any linear drift is in the lyric timeline."
          : "That is not 1.0 — our clock is stretching time and the drift is ours."),
    );
  } else {
    const ppm = Math.round((totalPos / totalWall - 1) * 1_000_000);
    console.log(
      `[diag] player advanced ${(totalPos / 1000).toFixed(1)}s over ${(totalWall / 1000).toFixed(1)}s ` +
        `wall — rate error ${ppm >= 0 ? "+" : ""}${ppm} ppm (${(ppm / 10_000).toFixed(3)}%)`,
    );
    console.log(
      Math.abs(ppm) < 2000
        ? "[diag] → clock is locked to the player. Drift you see is in the lyric timeline."
        : "[diag] → our clock is NOT tracking the player. Drift is ours.",
    );
  }
  if (marks.length > 0) {
    console.table(
      marks.map((m, i) => ({
        "#": i + 1,
        raw: fmt(m.rawMs),
        truth: fmt(m.truthMs),
        "err(s)": ((m.rawMs - m.truthMs) / 1000).toFixed(2),
        line: m.lineIdx,
      })),
    );
  }
  fit();
}

export function install(h: DiagHost): void {
  host = h;
  (window as unknown as Record<string, unknown>).__diag = {
    lines: showLines,
    mark,
    fit,
    apply,
    summary,
    reset,
    marks: () => marks,
    rates: () => rates,
  };
  console.log(
    "[diag] ready. __diag.lines() to see the timeline, __diag.mark(i) while line i is sung, " +
      "__diag.summary() for the verdict, __diag.apply() to write the fit to this track.",
  );
}
