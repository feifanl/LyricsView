import { describe, expect, it } from "vitest";
import { parseFurigana } from "./furigana";

/** kuroshiro's exact output shape for one annotated word. */
function ruby(base: string, reading: string): string {
  return `<ruby>${base}<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby>`;
}

describe("parseFurigana", () => {
  it("reads a single ruby group", () => {
    expect(parseFurigana(ruby("日本語", "にほんご"))).toEqual([
      { kind: "ruby", base: "日本語", reading: "にほんご" },
    ]);
  });

  it("keeps the text between groups", () => {
    const html = `これは${ruby("日本", "にほん")}の${ruby("歌", "うた")}です`;
    expect(parseFurigana(html)).toEqual([
      { kind: "text", text: "これは" },
      { kind: "ruby", base: "日本", reading: "にほん" },
      { kind: "text", text: "の" },
      { kind: "ruby", base: "歌", reading: "うた" },
      { kind: "text", text: "です" },
    ]);
  });

  it("passes through a line with no annotations", () => {
    expect(parseFurigana("ひらがなだけ")).toEqual([{ kind: "text", text: "ひらがなだけ" }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseFurigana("")).toEqual([]);
  });

  // --- the reason this module exists ------------------------------------
  // kuroshiro interpolates lyric text into its template without escaping, and
  // lyrics come from providers whose catalogues are user-submitted. None of the
  // markup below may survive as markup.

  it("strips a script tag smuggled in through the lyric", () => {
    const tokens = parseFurigana(`<script>alert(1)</script>${ruby("歌", "うた")}`);
    expect(tokens).toEqual([
      { kind: "text", text: "alert(1)" },
      { kind: "ruby", base: "歌", reading: "うた" },
    ]);
    expect(JSON.stringify(tokens)).not.toContain("<script");
  });

  it("strips an event handler carried inside a ruby base", () => {
    const tokens = parseFurigana(ruby(`<img src=x onerror="alert(1)">歌`, "うた"));
    expect(tokens).toEqual([{ kind: "ruby", base: "歌", reading: "うた" }]);
    expect(JSON.stringify(tokens)).not.toContain("onerror");
  });

  it("strips markup carried inside a reading", () => {
    const tokens = parseFurigana(ruby("歌", `<img src=x onerror=alert(1)>うた`));
    expect(tokens).toEqual([{ kind: "ruby", base: "歌", reading: "うた" }]);
  });

  it("degrades a malformed ruby group to plain text", () => {
    // No closing tag: it must not be treated as an annotation, and must not
    // leave markup behind either.
    const tokens = parseFurigana("<ruby>歌<rt>うた");
    expect(tokens).toEqual([{ kind: "text", text: "歌うた" }]);
  });

  it("never emits a tag name outside ruby/rt/rp", () => {
    const hostile = `<iframe src=javascript:alert(1)></iframe><svg onload=alert(1)>${ruby("歌", "うた")}`;
    for (const t of parseFurigana(hostile)) {
      if (t.kind === "text") expect(t.text).not.toMatch(/[<>]/);
      else {
        expect(t.base).not.toMatch(/[<>]/);
        expect(t.reading).not.toMatch(/[<>]/);
      }
    }
  });
});
