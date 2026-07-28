// Which lines deserve a translation sub-line. Pure logic, unit-tested
// (translation.test.ts).
//
// The rule used to be per-document: if the song as a whole was already in the
// user's target language, every translation was dropped. That misses two cases
// the moment a song isn't uniform — and songs rarely are:
//
//   - a Japanese track with an English hook, target English: the doc reads as
//     "ja", so the hook keeps a "translation" that restates it in English;
//   - a provider that echoes the original back as its own translation on lines
//     it has nothing for.
//
// Both show the same words twice. So the decision belongs per line, with the
// document-level check kept only as a cheap early-out.
import { detectScript } from "./romanize";

/** Language bucket of a piece of text, by script. Latin-script text can't be
 *  told apart any finer than "latin" — good enough, since the target language
 *  collapses the same way. */
export function langOf(text: string): string {
  const s = detectScript(text); // ja | zh | ko | ru | other
  return s === "other" ? "latin" : s;
}

/** Target-language code reduced to the same buckets `langOf` produces. */
export function baseLang(code: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0] ?? code.toLowerCase();
  return /^(en|es|fr|de|it|pt|nl|id|ms|vi|tr|pl)$/.test(base) ? "latin" : base;
}

/** Dominant original language across a document's non-empty lines. */
export function docLang(texts: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const lang = langOf(trimmed);
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best = "latin";
  let max = 0;
  for (const [lang, n] of counts) {
    if (n > max) {
      max = n;
      best = lang;
    }
  }
  return best;
}

/** Letters and digits only, case-folded — so punctuation, spacing and casing
 *  don't hide the fact that two strings say the same thing. */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * True when a translation for `original` would add nothing: the line is already
 * in the target language, or the "translation" restates the original.
 */
export function isRedundantTranslation(
  original: string,
  translation: string | undefined,
  targetLang: string,
): boolean {
  if (!translation || !translation.trim()) return true;
  if (comparable(translation) === comparable(original)) return true;
  return langOf(original) === baseLang(targetLang);
}

/** True when a line is worth sending to the translator at all. */
export function needsTranslation(original: string, targetLang: string): boolean {
  const text = original.trim();
  if (!text) return false;
  return langOf(text) !== baseLang(targetLang);
}
