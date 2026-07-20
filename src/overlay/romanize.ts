// Offline romanization with lazy per-language loaders. Script is detected by
// Unicode range; each language is initialized on first use to keep startup
// fast. All conversions are fail-soft — a loader error yields no sub-line
// rather than breaking the overlay.
import type { RomanizationCfg } from "../shared/settings";

export type Script = "ja" | "zh" | "ko" | "ru" | "other";

export interface Annotation {
  romaji?: string;
  /** Ruby HTML for Japanese furigana mode (rendered on the static text layer). */
  furiganaHtml?: string;
}

const RANGES = {
  hiragana: /[぀-ゟ]/,
  katakana: /[゠-ヿ]/,
  cjk: /[㐀-䶿一-鿿]/,
  hangul: /[가-힣ᄀ-ᇿ]/,
  cyrillic: /[Ѐ-ӿ]/,
};

export function detectScript(text: string): Script {
  if (RANGES.hiragana.test(text) || RANGES.katakana.test(text)) return "ja";
  if (RANGES.hangul.test(text)) return "ko";
  if (RANGES.cyrillic.test(text)) return "ru";
  if (RANGES.cjk.test(text)) return "zh";
  return "other";
}

function scriptEnabled(script: Script, cfg: RomanizationCfg): boolean {
  // `auto` romanizes every detected non-Latin script; per-language flags act as
  // overrides to enable a single script while auto is off.
  switch (script) {
    case "ja":
      return cfg.auto || cfg.ja;
    case "zh":
      return cfg.auto || cfg.zh;
    case "ko":
      return cfg.auto || cfg.ko;
    case "ru":
      return cfg.auto || cfg.ru;
    default:
      return false;
  }
}

// ---- Lazy loaders ----

let kuroshiroPromise: Promise<import("kuroshiro").default | null> | null = null;
async function getKuroshiro(): Promise<import("kuroshiro").default | null> {
  if (!kuroshiroPromise) {
    kuroshiroPromise = (async () => {
      try {
        const { default: Kuroshiro } = await import("kuroshiro");
        const { default: KuromojiAnalyzer } = await import("kuroshiro-analyzer-kuromoji");
        const kuroshiro = new Kuroshiro();
        await kuroshiro.init(new KuromojiAnalyzer({ dictPath: "/kuromoji-dict" }));
        return kuroshiro;
      } catch (e) {
        console.error("[romanize] kuroshiro init failed", e);
        return null;
      }
    })();
  }
  return kuroshiroPromise;
}

let cyrillicInstance: { transform(s: string): string } | null | undefined;
async function getCyrillic(): Promise<{ transform(s: string): string } | null> {
  if (cyrillicInstance === undefined) {
    try {
      const { default: CyrillicToTranslit } = await import("cyrillic-to-translit-js");
      cyrillicInstance = new CyrillicToTranslit();
    } catch (e) {
      console.error("[romanize] cyrillic loader failed", e);
      cyrillicInstance = null;
    }
  }
  return cyrillicInstance;
}

async function zhPinyin(text: string): Promise<string> {
  const { pinyin } = await import("pinyin-pro");
  return pinyin(text, { toneType: "symbol", type: "string" });
}

async function koRomaja(text: string): Promise<string> {
  const { Romanize } = await import("hangul-romanize");
  return Romanize.fromString(text);
}

/** Produce a romanized sub-line (and optional furigana HTML) for a lyric line. */
export async function annotate(text: string, cfg: RomanizationCfg): Promise<Annotation> {
  const script = detectScript(text);
  if (!scriptEnabled(script, cfg)) return {};
  try {
    switch (script) {
      case "ja": {
        const kuroshiro = await getKuroshiro();
        if (!kuroshiro) return {};
        const out: Annotation = {
          romaji: await kuroshiro.convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" }),
        };
        if (cfg.jaFurigana) {
          out.furiganaHtml = await kuroshiro.convert(text, { to: "hiragana", mode: "furigana" });
        }
        return out;
      }
      case "zh":
        return { romaji: await zhPinyin(text) };
      case "ko":
        return { romaji: await koRomaja(text) };
      case "ru": {
        const c = await getCyrillic();
        return c ? { romaji: c.transform(text) } : {};
      }
      default:
        return {};
    }
  } catch (e) {
    console.error("[romanize] annotate failed", e);
    return {};
  }
}

export function romanizationActive(cfg: RomanizationCfg): boolean {
  return cfg.auto || cfg.ja || cfg.zh || cfg.ko || cfg.ru;
}
