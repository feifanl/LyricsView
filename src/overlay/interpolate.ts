// Word-timing synthesis for line-level lyrics (LRCLIB etc.). Pure + tested.
//
// A line's duration is distributed across "fill units" weighted by visual
// length. Latin scripts split on whitespace; CJK runs split per character (each
// CJK glyph is its own fill unit). Weight = grapheme count (via Intl.Segmenter),
// excluding whitespace. This "interpolated karaoke" is the default look for
// line-only providers and reads ~90% correct.
import type { LyricWord } from "../shared/types";

const graphemeSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** CJK & Japanese/Korean ranges where each glyph is an independent fill unit. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK Ext B+
  );
}

function unitWeight(text: string): number {
  let n = 0;
  for (const { segment } of graphemeSeg.segment(text)) {
    if (!isWhitespace(segment)) n += 1;
  }
  return Math.max(1, n);
}

/** Split a line into fill units, keeping trailing whitespace on each unit. */
export function splitUnits(text: string): string[] {
  const units: string[] = [];
  let cur = "";
  let curIsCjk = false;
  let endedBySpace = false;
  const flush = (): void => {
    if (cur) units.push(cur);
    cur = "";
    curIsCjk = false;
    endedBySpace = false;
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isWhitespace(ch)) {
      cur += ch;
      endedBySpace = true;
    } else if (isCjk(cp)) {
      if (cur) flush();
      cur = ch;
      curIsCjk = true;
    } else {
      if (curIsCjk || endedBySpace) flush();
      cur += ch;
      endedBySpace = false;
    }
  }
  flush();
  return units;
}

export function synthesizeWords(text: string, start: number, end: number): LyricWord[] {
  const units = splitUnits(text);
  if (units.length === 0) return [];
  const duration = Math.max(0, end - start);
  const weights = units.map(unitWeight);
  const total = weights.reduce((a, b) => a + b, 0);

  const words: LyricWord[] = [];
  let acc = start;
  for (let i = 0; i < units.length; i++) {
    const share = total > 0 ? (duration * weights[i]!) / total : 0;
    const wStart = Math.round(acc);
    acc += share;
    const wEnd = i === units.length - 1 ? end : Math.round(acc);
    words.push({ start: wStart, end: Math.max(wStart, wEnd), text: units[i]! });
  }
  return words;
}
