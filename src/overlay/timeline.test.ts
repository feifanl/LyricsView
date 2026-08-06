import { describe, expect, it } from "vitest";
import { contextRange, lineIndexAt, type LineSpan } from "./timeline";

/** Lines the way the parser emits them: each ends where the next begins. */
function chain(entries: [start: number, text: string][], trailingMs = 4000) {
  return entries.map(([start, text], i) => ({
    start,
    end: entries[i + 1]?.[0] ?? start + trailingMs,
    chars: text.length,
  }));
}

const SHORT = "500 miles"; // 9 chars -> floor of 8 s applies
const LONG = "Lord I'm one, Lord I'm two, Lord I'm three, Lord I'm four";

describe("lineIndexAt", () => {
  const lines = chain([
    [10_000, SHORT],
    [13_000, SHORT],
    [16_000, SHORT],
  ]);

  it("shows nothing during the intro", () => {
    expect(lineIndexAt(lines, 0)).toBe(-1);
    expect(lineIndexAt(lines, 9_999)).toBe(-1);
  });

  it("follows normally spaced lines with no gap between them", () => {
    expect(lineIndexAt(lines, 10_000)).toBe(0);
    expect(lineIndexAt(lines, 12_999)).toBe(0);
    expect(lineIndexAt(lines, 13_000)).toBe(1);
    expect(lineIndexAt(lines, 16_000)).toBe(2);
  });

  it("holds a slow line while the singer is still on it", () => {
    // The 500 Miles case: sparse folk phrasing leaves 14 s between line starts,
    // with the last word held most of it. That is not an instrumental break.
    const sparse = chain([
      [10_000, SHORT],
      [24_000, SHORT],
    ]);
    expect(lineIndexAt(sparse, 21_000)).toBe(0);
    expect(lineIndexAt(sparse, 23_999)).toBe(0);
  });

  it("gives a wordy line proportionally longer before cutting", () => {
    const wordy = chain([
      [10_000, LONG],
      [45_000, SHORT],
    ]);
    // ~57 chars earns roughly 31 s of rope, so 25 s in it is still showing.
    expect(lineIndexAt(wordy, 35_000)).toBe(0);
  });

  it("empties the box during a real instrumental break", () => {
    // Verse ends, 35 s solo, verse resumes.
    const withSolo = chain([
      [10_000, SHORT],
      [45_000, SHORT],
    ]);
    expect(lineIndexAt(withSolo, 27_000)).toBe(0); // still holding
    expect(lineIndexAt(withSolo, 28_001)).toBe(-1); // break: nothing
    expect(lineIndexAt(withSolo, 44_000)).toBe(-1);
    expect(lineIndexAt(withSolo, 45_000)).toBe(1); // singing resumes
  });

  it("bridges the gap word-level timings leave between lines", () => {
    // yrc/richsync/TTML report when singing actually stops, so `end` falls short
    // of the next line's start. Those gaps must not blank the box.
    const wordLevel = [
      { start: 10_000, end: 12_500, chars: SHORT.length },
      { start: 14_270, end: 17_000, chars: SHORT.length },
    ];
    expect(lineIndexAt(wordLevel, 12_500)).toBe(0); // singing stopped
    expect(lineIndexAt(wordLevel, 14_269)).toBe(0); // still shown across the gap
    expect(lineIndexAt(wordLevel, 14_270)).toBe(1); // next line takes over
  });

  it("keeps a long held line up through all of its singing", () => {
    // A 14 s sung line outlasts the plausible-length clamp; the clamp must not
    // cut it while the note is still going.
    const held = [{ start: 10_000, end: 24_000, chars: SHORT.length }];
    expect(lineIndexAt(held, 23_500)).toBe(0);
  });

  it("clears the final line after the outro instead of freezing on it", () => {
    expect(lineIndexAt(lines, 25_999)).toBe(2);
    expect(lineIndexAt(lines, 26_000)).toBe(-1);
  });

  it("shows nothing while a blank line holds the timeline", () => {
    // Providers mark an instrumental with an empty line spanning the whole
    // break. This used to read as "length unknown, so never cut it", which held
    // the box open on an empty row for the full half-minute — and on a preset
    // with context, displayed the lines either side of the break together as
    // though they were being sung. Nothing is sung here, so show nothing.
    const withBreak = [
      { start: 0, end: 4_000, chars: 12 },
      { start: 97_500, end: 132_500, chars: 0 },
      { start: 132_500, end: 140_400, chars: 16 },
    ];
    expect(lineIndexAt(withBreak, 110_000)).toBe(-1);
    expect(lineIndexAt(withBreak, 132_000)).toBe(-1);
    expect(lineIndexAt(withBreak, 134_000)).toBe(2);
  });

  it("handles an empty document", () => {
    expect(lineIndexAt([], 5_000)).toBe(-1);
  });
});

describe("contextRange", () => {
  const span = (start: number, end: number, chars = 12): LineSpan => ({ start, end, chars });

  it("takes the neighbours either side when the lines run on", () => {
    const lines = [span(0, 3000), span(3200, 6000), span(6200, 9000)];
    expect(contextRange(lines, 1, 1, 1)).toEqual({ start: 0, end: 2 });
  });

  it("stops before an instrumental instead of showing the line after it", () => {
    // The Karaoke-preset bug: line 2 doesn't start for another 21s, but it sits
    // next to line 1 in the array, so index-only context put it on screen the
    // moment the break began.
    const lines = [span(86400, 91100), span(91800, 95800), span(116700, 122500)];
    expect(contextRange(lines, 1, 1, 1)).toEqual({ start: 0, end: 1 });
  });

  it("stops after an instrumental instead of holding the line before it", () => {
    const lines = [span(86400, 91100), span(91800, 95800), span(116700, 122500), span(122500, 126100)];
    expect(contextRange(lines, 2, 1, 1)).toEqual({ start: 2, end: 3 });
  });

  it("tolerates the ordinary gap word-level timings leave between lines", () => {
    const lines = [span(0, 3000), span(4500, 7000), span(8800, 11000)];
    expect(contextRange(lines, 1, 1, 1)).toEqual({ start: 0, end: 2 });
  });

  it("stops at a blank separator line", () => {
    const lines = [span(0, 3000), span(3100, 3200, 0), span(3300, 6000)];
    expect(contextRange(lines, 2, 1, 1)).toEqual({ start: 2, end: 2 });
  });

  it("clamps at the ends of the document", () => {
    const lines = [span(0, 3000), span(3200, 6000)];
    expect(contextRange(lines, 0, 1, 1)).toEqual({ start: 0, end: 1 });
    expect(contextRange(lines, 1, 1, 1)).toEqual({ start: 0, end: 1 });
  });

  it("returns just the line itself when the preset shows no context", () => {
    const lines = [span(0, 3000), span(3200, 6000), span(6200, 9000)];
    expect(contextRange(lines, 1, 0, 0)).toEqual({ start: 1, end: 1 });
  });

  it("walks more than one line out when asked", () => {
    const lines = [span(0, 3000), span(3200, 6000), span(6200, 9000), span(9200, 12000), span(12200, 15000)];
    expect(contextRange(lines, 2, 2, 2)).toEqual({ start: 0, end: 4 });
  });
});
