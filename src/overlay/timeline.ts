// Which lyric line is on screen at a playback position. Pure logic,
// unit-tested (timeline.test.ts).
//
// `end` means different things by source. Line-level LRC has no idea when
// singing stops, so the parser fills in the *next* line's start: the span
// swallows any silence that follows. Word-level sources (yrc, richsync, TTML)
// report the real end of singing, leaving a genuine gap before the next line —
// commonly a second or two, and on more than half the lines of a typical track.
//
// So a line must outlive its own `end` by a comfortable margin, or every one of
// those gaps blanks the box between lines. It must also not outlive it forever,
// or an instrumental break leaves the last sung line frozen for half a minute
// and the outro line stays up until the track changes.
//
// Hence: visible until singing stops, plus a linger. The stop point is clamped
// by what the line's own text plausibly takes to sing, which is what catches the
// LRC case where `end` is really the far side of a break. Cutting a line the
// singer is still on is the worse error, so every constant here errs long.

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
/** How long a finished line stays up before the box empties. Must clear the
 *  gaps word-level timings leave between lines — a second or two is routine —
 *  by enough margin that normal phrasing never flickers. */
const LINGER_MS = 6_000;

/** How long the line's own text could plausibly occupy. */
function plausibleSungMs(chars: number): number {
  if (chars <= 0) return Number.POSITIVE_INFINITY; // unknown: never cut
  return Math.max(MIN_HOLD_MS, chars * MS_PER_CHAR * SLACK);
}

/** Last moment `line` should remain on screen. */
function visibleUntil(line: LineSpan): number {
  // Clamping to the plausible sung length is what stops an LRC line — whose
  // `end` is really the next line's start — from riding out a whole solo. It
  // never shortens a line below its own singing, since the clamp only binds
  // once `end` is further out than the words can account for.
  const sungUntil = Math.min(line.end, line.start + plausibleSungMs(line.chars));
  return sungUntil + LINGER_MS;
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
