import { describe, expect, it } from "vitest";
import { docLang, isRedundantTranslation, needsTranslation } from "./translation";

describe("isRedundantTranslation", () => {
  it("drops a translation that restates the original", () => {
    // Providers echo the line back when they have nothing for it.
    expect(isRedundantTranslation("Hold me close", "Hold me close", "en")).toBe(true);
    expect(isRedundantTranslation("Hold me close", "hold me close!", "en")).toBe(true);
  });

  it("drops a translation on a line already in the target language", () => {
    // The reported case: an English hook inside a Japanese song, target English.
    expect(isRedundantTranslation("I don't wanna know", "I do not want to know", "en")).toBe(true);
  });

  it("keeps a real translation", () => {
    expect(isRedundantTranslation("君のことが好き", "I like you", "en")).toBe(false);
    expect(isRedundantTranslation("사랑해", "I love you", "en")).toBe(false);
  });

  it("treats a missing or blank translation as nothing to show", () => {
    expect(isRedundantTranslation("君のことが好き", undefined, "en")).toBe(true);
    expect(isRedundantTranslation("君のことが好き", "   ", "en")).toBe(true);
  });

  it("keeps translations into a non-Latin target", () => {
    expect(isRedundantTranslation("I like you", "君のことが好き", "ja")).toBe(false);
  });
});

describe("needsTranslation", () => {
  it("skips lines already in the target language", () => {
    expect(needsTranslation("Hold me close", "en")).toBe(false);
    expect(needsTranslation("", "en")).toBe(false);
  });

  it("sends lines in another script", () => {
    expect(needsTranslation("君のことが好き", "en")).toBe(true);
  });
});

describe("docLang", () => {
  it("reports the dominant script, not the outliers", () => {
    expect(docLang(["君のことが好き", "会いたい", "I don't wanna know"])).toBe("ja");
    expect(docLang(["Hold me close", "and never let go"])).toBe("latin");
  });

  it("ignores blank lines", () => {
    expect(docLang(["", "   ", "사랑해"])).toBe("ko");
  });
});

describe("bundled translations in the wrong language", () => {
  it("drops a Chinese tlyric on a Korean song when targeting English", () => {
    expect(isRedundantTranslation("죽어도 못 보내", "就算死也不能送走", "en")).toBe(true);
  });

  it("keeps that same Chinese translation when the target is Chinese", () => {
    expect(isRedundantTranslation("죽어도 못 보내", "就算死也不能送走", "zh")).toBe(false);
  });

  it("keeps an English translation of a Korean line when targeting English", () => {
    expect(isRedundantTranslation("죽어도 못 보내", "I can't let you go", "en")).toBe(false);
  });

  it("drops a Japanese translation when targeting English", () => {
    expect(isRedundantTranslation("죽어도 못 보내", "死んでも離さない", "en")).toBe(true);
  });
});
