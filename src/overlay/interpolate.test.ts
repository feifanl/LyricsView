import { describe, expect, it } from "vitest";
import { splitUnits, synthesizeWords } from "./interpolate";

describe("splitUnits", () => {
  it("splits Latin text on whitespace, keeping trailing spaces", () => {
    expect(splitUnits("Never gonna give")).toEqual(["Never ", "gonna ", "give"]);
  });

  it("splits CJK runs per character", () => {
    expect(splitUnits("我爱你")).toEqual(["我", "爱", "你"]);
  });

  it("handles mixed Latin + CJK", () => {
    expect(splitUnits("hi 我 there")).toEqual(["hi ", "我 ", "there"]);
  });

  it("returns [] for empty text", () => {
    expect(splitUnits("")).toEqual([]);
  });
});

describe("synthesizeWords", () => {
  it("covers the whole line duration contiguously", () => {
    const words = synthesizeWords("Never gonna give", 1000, 4000);
    expect(words[0]!.start).toBe(1000);
    expect(words.at(-1)!.end).toBe(4000);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBe(words[i - 1]!.end);
    }
  });

  it("weights longer words with more time", () => {
    const words = synthesizeWords("a longword", 0, 1000);
    const short = words[0]!.end - words[0]!.start;
    const long = words[1]!.end - words[1]!.start;
    expect(long).toBeGreaterThan(short);
  });

  it("distributes CJK characters evenly", () => {
    const words = synthesizeWords("我爱你", 0, 3000);
    expect(words.map((w) => w.text)).toEqual(["我", "爱", "你"]);
    expect(words[0]!.start).toBe(0);
    expect(words[2]!.end).toBe(3000);
    // Roughly equal thirds.
    expect(words[1]!.start).toBeCloseTo(1000, -2);
  });

  it("handles a single word", () => {
    const words = synthesizeWords("solo", 500, 900);
    expect(words).toHaveLength(1);
    expect(words[0]).toEqual({ start: 500, end: 900, text: "solo" });
  });

  it("handles zero-length duration without negative spans", () => {
    const words = synthesizeWords("a b c", 1000, 1000);
    for (const w of words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });
});
