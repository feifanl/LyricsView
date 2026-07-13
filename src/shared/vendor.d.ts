// Minimal type declarations for romanization libraries that ship no types.

declare module "kuroshiro" {
  interface ConvertOptions {
    to?: "hiragana" | "katakana" | "romaji";
    mode?: "normal" | "spaced" | "okurigana" | "furigana";
    romajiSystem?: "nippon" | "passport" | "hepburn";
    delimiter_start?: string;
    delimiter_end?: string;
  }
  interface Analyzer {
    init(): Promise<void>;
  }
  export default class Kuroshiro {
    init(analyzer: Analyzer): Promise<void>;
    convert(text: string, options?: ConvertOptions): Promise<string>;
  }
}

declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(options?: { dictPath?: string });
    init(): Promise<void>;
  }
}

declare module "cyrillic-to-translit-js" {
  interface CyrillicToTranslitInstance {
    transform(input: string, spaceReplacement?: string): string;
    reverse(input: string, spaceReplacement?: string): string;
  }
  interface CyrillicToTranslitConstructor {
    new (options?: { preset?: "ru" | "uk" | "mn" }): CyrillicToTranslitInstance;
  }
  const CyrillicToTranslit: CyrillicToTranslitConstructor;
  export default CyrillicToTranslit;
}
