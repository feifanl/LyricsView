// Turns kuroshiro's furigana HTML into DOM nodes without ever handing a string
// to innerHTML.
//
// kuroshiro builds its ruby markup by interpolating token text straight into a
// template — it does not escape anything (see kuroshiro/src/core.js). The token
// text is provider lyrics, and LRCLIB's catalogue is user-submitted, so the
// output is untrusted markup. Assigning it to innerHTML let a crafted lyric line
// run script in the overlay, which has access to the Tauri IPC bridge and every
// command the app's capabilities grant.
//
// The defence is structural rather than a filter: parse the markup into a small
// closed set of tokens, then build the nodes with createElement and textContent.
// Nothing in this file can produce an element other than ruby/rt/rp, and no
// attribute is ever copied, so an onerror= or a <script> cannot survive whatever
// the parser makes of it.

/** Ruby annotation: `base` is the kanji, `reading` the kana above it. */
export type FuriganaToken =
  | { kind: "text"; text: string }
  | { kind: "ruby"; base: string; reading: string };

/** kuroshiro emits `<ruby>BASE<rp>(</rp><rt>READING</rt><rp>)</rp></ruby>`.
 *  The `rp` fallbacks are for browsers with no ruby support; we rebuild them. */
const RUBY = /<ruby>(.*?)<rp>.*?<\/rp><rt>(.*?)<\/rt><rp>.*?<\/rp><\/ruby>/gs;

/** Drop any markup left inside a captured fragment. Belt and braces: the caller
 *  only ever renders these through textContent, so a stray tag would show as
 *  literal text rather than execute — but a lyric shouldn't render as `<img
 *  src=x onerror=...>` either. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/**
 * Parse furigana markup into tokens. Anything that isn't a well-formed ruby
 * group is carried through as text, so malformed or hostile input degrades to
 * the lyric shown plainly rather than to an error.
 */
export function parseFurigana(html: string): FuriganaToken[] {
  const tokens: FuriganaToken[] = [];
  let last = 0;
  for (const m of html.matchAll(RUBY)) {
    const at = m.index;
    if (at > last) {
      const text = stripTags(html.slice(last, at));
      if (text) tokens.push({ kind: "text", text });
    }
    tokens.push({ kind: "ruby", base: stripTags(m[1] ?? ""), reading: stripTags(m[2] ?? "") });
    last = at + m[0].length;
  }
  const tail = stripTags(html.slice(last));
  if (tail) tokens.push({ kind: "text", text: tail });
  return tokens;
}

/** Build the nodes for a furigana line. Text only ever reaches the DOM through
 *  textContent, and no attributes are set. */
export function furiganaFragment(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const t of parseFurigana(html)) {
    if (t.kind === "text") {
      frag.append(document.createTextNode(t.text));
      continue;
    }
    const ruby = document.createElement("ruby");
    ruby.append(document.createTextNode(t.base));
    // Keep the rp parentheses so a copy-paste of the line reads sensibly.
    const open = document.createElement("rp");
    open.textContent = "(";
    const rt = document.createElement("rt");
    rt.textContent = t.reading;
    const close = document.createElement("rp");
    close.textContent = ")";
    ruby.append(open, rt, close);
    frag.append(ruby);
  }
  return frag;
}
