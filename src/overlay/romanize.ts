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

/** Share of a line's letters a script must hold to be called the line's script.
 *
 *  Detection cannot be "does any character match": lyrics providers ship
 *  homoglyph substitutions — a Cyrillic "е" (U+0435) dropped inside an English
 *  word — to dodge content matching. One such character used to make an English
 *  line read as Russian, which transliterated it back into itself (a romaji
 *  sub-line duplicating the lyric) and defeated the same-language check that
 *  suppresses redundant translations.
 *
 *  A real mixed line clears this easily; a stray character or two cannot. The
 *  cost is that a mostly-English line with a token foreign word goes
 *  un-romanized, which is the quieter failure. */
const MIN_SCRIPT_SHARE = 0.2;

/** Dominant script of a line, by share of its letters. */
export function detectScript(text: string): Script {
  let ja = 0;
  let ko = 0;
  let ru = 0;
  let zh = 0;
  let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue; // punctuation, digits and spacing don't vote
    letters += 1;
    if (RANGES.hiragana.test(ch) || RANGES.katakana.test(ch)) ja += 1;
    else if (RANGES.hangul.test(ch)) ko += 1;
    else if (RANGES.cyrillic.test(ch)) ru += 1;
    else if (RANGES.cjk.test(ch)) zh += 1;
  }
  if (letters === 0) return "other";

  // Kana beat kanji: Japanese prose is mostly kanji by count, so a line with any
  // meaningful kana share is Japanese rather than Chinese.
  const jaShare = (ja + zh) / letters;
  if (ja / letters >= MIN_SCRIPT_SHARE || (ja > 0 && jaShare >= MIN_SCRIPT_SHARE)) return "ja";
  if (ko / letters >= MIN_SCRIPT_SHARE) return "ko";
  if (ru / letters >= MIN_SCRIPT_SHARE) return "ru";
  if (zh / letters >= MIN_SCRIPT_SHARE) return "zh";
  return "other";
}

/** Whether this line should produce romaji under the current config — true only
 *  when its detected script is non-Latin AND enabled. Latin/English lines return
 *  false, so callers don't show a "no romaji" note for text that never romanizes. */
export function expectsRomaji(text: string, cfg: RomanizationCfg): boolean {
  return scriptEnabled(detectScript(text), cfg);
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

/** Letters and digits only, case-folded — for telling whether a transliteration
 *  actually changed anything. */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Produce a romanized sub-line (and optional furigana HTML) for a lyric line.
 *  A transliteration that comes back saying the same thing as the input is not
 *  a romanization — it's the lyric shown twice — so it's dropped. */
export async function annotate(text: string, cfg: RomanizationCfg): Promise<Annotation> {
  const out = await romanize(text, cfg);
  if (out.romaji && comparable(out.romaji) === comparable(text)) delete out.romaji;
  return out;
}

async function romanize(text: string, cfg: RomanizationCfg): Promise<Annotation> {
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

export { romanizationOn as romanizationActive } from "../shared/settings";
