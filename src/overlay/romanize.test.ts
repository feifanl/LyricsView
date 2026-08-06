import { describe, expect, it } from "vitest";
import type { RomanizationCfg } from "../shared/settings";
import { annotate, detectScript } from "./romanize";

const ALL: RomanizationCfg = { auto: false, ja: true, jaFurigana: false, zh: true, ko: true, ru: true };

describe("detectScript", () => {
  it("detects Japanese by kana", () => {
    expect(detectScript("これは日本語")).toBe("ja");
  });
  it("detects Chinese by ideographs (no kana)", () => {
    expect(detectScript("我爱你")).toBe("zh");
  });
  it("detects Korean hangul", () => {
    expect(detectScript("안녕하세요")).toBe("ko");
  });
  it("detects Russian cyrillic", () => {
    expect(detectScript("Привет")).toBe("ru");
  });
  it("returns other for Latin", () => {
    expect(detectScript("plain english text here")).toBe("other");
  });

  it("ignores a homoglyph planted in an English line", () => {
    // NetEase ships lyrics with a Cyrillic "е" (U+0435) inside English words to
    // dodge content matching. One such character must not make the line Russian.
    expect(detectScript("Or “you’re dеad” lights as the angler fish bite")).toBe(
      "other",
    );
    expect(detectScript("More like a deer in the hеadlights")).toBe("other");
  });

  it("still detects a genuinely mixed line by its dominant script", () => {
    expect(detectScript("Baby 愛してる")).toBe("ja");
    expect(detectScript("Привет baby")).toBe("ru");
  });

  it("detects a single-character line", () => {
    expect(detectScript("愛")).toBe("zh");
  });

  it("returns other for text with no letters", () => {
    expect(detectScript("!!! ??? 123")).toBe("other");
  });
});

describe("annotate", () => {
  it("produces pinyin for Chinese", async () => {
    const ann = await annotate("我爱你", ALL);
    expect(ann.romaji).toBeTruthy();
    expect(ann.romaji).toMatch(/wǒ|wo/i);
  });

  // The loaders below are asserted on their exact output, not merely truthiness,
  // and on realistic lyric text rather than a bare word. `annotate` is
  // fail-soft: a loader that throws yields `{}` and the overlay shows no
  // sub-line, so a weak assertion passes while the feature is dead. Both traps
  // have been sprung here — a single-word Korean case passed for months while
  // every real lyric line romanized to "".
  it("produces romaja for Korean", async () => {
    const ann = await annotate("안녕하세요", ALL);
    expect(ann.romaji).toBe("annyeonghaseyo");
  });

  it("romanizes Korean across spaces and punctuation", async () => {
    // hangul-romanize returns "" for any input holding a single non-Hangul
    // character, so a whole lyric line has to be romanized run by run.
    // The exact spelling is the library's, not textbook Revised Romanization
    // (no nasal assimilation, no disambiguating hyphen). What matters here is
    // that all three words survive rather than the line collapsing to "".
    const ann = await annotate("아무도 없는 방에서", ALL);
    expect(ann.romaji).toBe("amudo eopneun bangeseo");
  });

  it("keeps non-Korean text inside a Korean line", async () => {
    const ann = await annotate("사랑, love 사랑!", ALL);
    expect(ann.romaji).toBe("sarang, love sarang!");
  });

  it("produces a transliteration for Russian", async () => {
    const ann = await annotate("Привет", ALL);
    expect(ann.romaji?.toLowerCase()).toBe("privet");
  });

  it("transliterates a full Russian line, not just one word", async () => {
    const ann = await annotate("Привет, как дела", ALL);
    expect(ann.romaji?.toLowerCase()).toBe("privet, kak dela");
  });

  it("produces pinyin across a full Chinese line", async () => {
    const ann = await annotate("我爱你 宝贝", ALL);
    expect(ann.romaji).toMatch(/wǒ.*ài.*nǐ.*bǎo.*bèi/);
  });

  it("returns empty when the script is disabled", async () => {
    const ann = await annotate("我爱你", { ...ALL, zh: false });
    expect(ann.romaji).toBeUndefined();
  });

  it("returns empty for Latin text", async () => {
    const ann = await annotate("hello", ALL);
    expect(ann).toEqual({});
  });

  it("drops a transliteration that restates the original", async () => {
    // Transliterating a homoglyph line yields the same English back; showing it
    // as a romaji sub-line duplicates the lyric.
    const ann = await annotate("Or “you’re dеad” lights", { ...ALL, auto: true });
    expect(ann.romaji).toBeUndefined();
  });

  it("auto romanizes any non-Latin script with per-language flags off", async () => {
    const auto: RomanizationCfg = { auto: true, ja: false, jaFurigana: false, zh: false, ko: false, ru: false };
    const ann = await annotate("我爱你", auto);
    expect(ann.romaji).toBeTruthy();
  });
});
