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
  /** Character count of the line's trimmed text. 0 means the line is blank —
   *  providers emit one to mark an instrumental, and there is nothing to sing or
   *  to show. */
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
/**
 * Silence between two lines that makes them musically unrelated, so the second
 * is not "the next line" in any sense the listener would recognise.
 *
 * Word-level sources leave a beat or two between ordinary lines, so this has to
 * sit well clear of routine phrasing; an instrumental, a verse break or a key
 * change runs far longer.
 */
const CONTEXT_GAP_MS = 6_000;

/**
 * The span of lines to show around `idx` for a preset that displays context.
 *
 * Neighbours are adjacent in the array, which says nothing about whether they
 * are adjacent in the song. Across an instrumental the "next" line can be half a
 * minute away, and index-only context put it on screen the moment the break
 * began — the lyric appeared long before it was sung, and the line from before
 * the break hung around long after. Walk outward from the current line and stop
 * at the first real silence.
 *
 * A blank line stops the walk too: it renders as an empty row, and providers use
 * one to mark exactly the section breaks this is trying not to cross.
 */
export function contextRange(
  lines: readonly LineSpan[],
  idx: number,
  before: number,
  after: number,
): { start: number; end: number } {
  let start = idx;
  let end = idx;
  for (let n = 0; n < before && start > 0; n++) {
    const prev = lines[start - 1]!;
    if (lines[start]!.start - prev.end > CONTEXT_GAP_MS || prev.chars === 0) break;
    start--;
  }
  for (let n = 0; n < after && end < lines.length - 1; n++) {
    const next = lines[end + 1]!;
    if (next.start - lines[end]!.end > CONTEXT_GAP_MS || next.chars === 0) break;
    end++;
  }
  return { start, end };
}

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
  // A blank line is an instrumental marker, not a lyric. Providers give it a
  // span covering the whole break — half a minute is common — so selecting it
  // pins the box open on nothing: an empty row where the lyric goes, and, for a
  // preset that shows context, the lines either side of the break displayed
  // together as though they were being sung.
  if (lines[found]!.chars === 0) return -1;
  return pos >= visibleUntil(lines[found]!) ? -1 : found;
}
