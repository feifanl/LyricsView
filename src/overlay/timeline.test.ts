import { describe, expect, it } from "vitest";
import { lineIndexAt } from "./timeline";

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
    expect(lineIndexAt(withSolo, 21_000)).toBe(0); // still holding
    expect(lineIndexAt(withSolo, 22_001)).toBe(-1); // break: nothing
    expect(lineIndexAt(withSolo, 44_000)).toBe(-1);
    expect(lineIndexAt(withSolo, 45_000)).toBe(1); // singing resumes
  });

  it("clears the final line after the outro instead of freezing on it", () => {
    expect(lineIndexAt(lines, 19_999)).toBe(2);
    expect(lineIndexAt(lines, 20_000)).toBe(-1);
  });

  it("never cuts a line whose text is unknown", () => {
    const unknown = [{ start: 0, end: 600_000, chars: 0 }];
    expect(lineIndexAt(unknown, 500_000)).toBe(0);
  });

  it("handles an empty document", () => {
    expect(lineIndexAt([], 5_000)).toBe(-1);
  });
});
