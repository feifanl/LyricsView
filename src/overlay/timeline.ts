// Which lyric line is on screen at a playback position. Pure logic,
// unit-tested (timeline.test.ts).
//
// The parser gives every line an end time of the *next* line's start, so a line
// nominally covers the silence after it too. That's right for normal spacing and
// wrong for an instrumental break: an 8-bar solo would leave the last sung line
// frozen on screen for half a minute. Same for the outro, where the final line
// otherwise stays up until the track changes.
//
// The span alone can't tell the two apart — a sparse folk verse and a short solo
// look identical. So the cut-off is measured against how long the line's own
// text plausibly takes to sing, generously: only a gap that dwarfs the words
// counts as a break. Cutting a line the singer is still holding is the worse
// error of the two, so every constant here errs long.

export interface LineSpan {
  start: number;
  end: number;
  /** Character count of the line's text; 0 means "unknown, assume long". */
  chars: number;
}

/** Rough singing rate. Latin text runs several characters per syllable, CJK
 *  about one, so this over-estimates Latin and under-estimates CJK — the slack
 *  factor and floor below absorb both. */
const MS_PER_CHAR = 220;
/** Multiplier covering held notes, rubato and pauses mid-line. */
const SLACK = 2.5;
/** No line is ever cut sooner than this, however few words it has. Set well past
 *  any plausible sung phrase: a short line followed by a long held note is
 *  common, and dropping the lyric while the singer is still on it is a much
 *  worse failure than a stale line during a solo. */
const MIN_HOLD_MS = 12_000;
/** A span must exceed the hold by this much before it's worth cutting at all —
 *  otherwise a line would lose its last second to gain nothing. */
const CUT_MARGIN_MS = 4_000;

/** How long the line's own text could plausibly occupy. */
function plausibleSungMs(chars: number): number {
  if (chars <= 0) return Number.POSITIVE_INFINITY; // unknown: never cut
  return Math.max(MIN_HOLD_MS, chars * MS_PER_CHAR * SLACK);
}

/** Last moment `line` should remain on screen. */
function visibleUntil(line: LineSpan): number {
  const span = line.end - line.start;
  const hold = plausibleSungMs(line.chars);
  return line.start + (span > hold + CUT_MARGIN_MS ? hold : span);
}

/**
 * Index of the line to display at `pos`, or -1 for "show nothing" — before the
 * first line (long intro), during an instrumental break, and after the outro.
 */
export function lineIndexAt(lines: readonly LineSpan[], pos: number): number {
  if (lines.length === 0 || pos < lines[0]!.start) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.start <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return pos >= visibleUntil(lines[found]!) ? -1 : found;
}
