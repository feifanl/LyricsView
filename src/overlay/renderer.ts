// Karaoke renderer: line stack (prev/current/next context) + progressive word
// fill, with optional romanization sub-lines and Japanese furigana. Per-frame
// style writes are limited to the active word for smoothness.
import type { AnimationStyle, RomanizationCfg } from "../shared/settings";
import type { LyricsDoc, LyricLine, LyricWord } from "../shared/types";
import { synthesizeWords } from "./interpolate";
import { annotate, romanizationActive } from "./romanize";

interface PreparedLine {
  line: LyricLine;
  words: LyricWord[];
  romaji?: string;
  furiganaHtml?: string;
  translation?: string;
}

export interface RenderLayout {
  before: number;
  after: number;
  animation: AnimationStyle;
}

const NO_ROMANIZATION: RomanizationCfg = { auto: false, ja: false, jaFurigana: false, zh: false, ko: false, ru: false };

/** Split a provider translation that leads with a bracketed transliteration
 *  ("【romaji】 english" or "[romaji] english") into the two parts. Returns the
 *  whole string as `text` when there's no such prefix (or no trailing text). */
function splitTranslation(t: string): { roman?: string; text: string } {
  const m = t.match(/^\s*[【[]([^】\]]+)[】\]]\s*(.+)$/s);
  if (m && m[2]!.trim()) return { roman: m[1]!.trim(), text: m[2]!.trim() };
  return { text: t };
}

export class Renderer {
  private prepared: PreparedLine[] = [];
  private plain: string | null = null;
  private currentIdx = -1;
  private wordSpans: HTMLElement[] = [];
  private prevActive = -1;
  private layout: RenderLayout = { before: 1, after: 1, animation: "fill" };
  private romanization: RomanizationCfg = NO_ROMANIZATION;
  private annVersion = 0;
  private currentWrapper: HTMLElement | null = null;
  private showTranslation = false;
  private fitQueued = false;

  constructor(private readonly container: HTMLElement) {
    // Refit when the window/bar is resized (e.g. dock height changed).
    const root = container.parentElement;
    if (root && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.scheduleFit()).observe(root);
    }
  }

  /** Coalesce fit passes to one per frame (measuring forces layout). */
  private scheduleFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fit();
    });
  }

  /** Shrink the font (and everything derived from it) until the content fits the
   *  bar, so a small bar height or big font never clips text or the box edges.
   *  --fit-scale multiplies --font-size-base; box padding is fixed, so refine a
   *  few times to converge. */
  private fit(): void {
    const root = this.container.parentElement as HTMLElement | null;
    if (!root) return;
    // Fit inside the padding box, and reserve a small safety margin so the
    // glass box's border, rounded corners and soft shadow aren't clipped by the
    // window edge (content == window would sit flush and shave the edges).
    const cs = getComputedStyle(root);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const SAFETY = 6;
    const availH = root.clientHeight - padY - SAFETY * 2;
    const availW = root.clientWidth - padX - SAFETY * 2;
    if (availH <= 0 || availW <= 0) return;

    const rootStyle = document.documentElement.style;
    let scale = 1;
    rootStyle.setProperty("--fit-scale", "1");
    for (let i = 0; i < 4; i++) {
      const needH = this.container.scrollHeight;
      const needW = this.container.scrollWidth;
      const step = Math.min(
        needH > availH ? availH / needH : 1,
        needW > availW ? availW / needW : 1,
      );
      if (step >= 0.999) break;
      scale = Math.max(0.3, scale * step);
      rootStyle.setProperty("--fit-scale", String(scale));
    }
  }

  setLayout(layout: RenderLayout): void {
    this.layout = layout;
    this.currentIdx = -1; // force rebuild with new context counts
  }

  setRomanization(cfg: RomanizationCfg): void {
    this.romanization = cfg;
    void this.annotateAll();
  }

  /** Toggle the translated sub-line (Original vs Translated view). */
  setShowTranslation(show: boolean): void {
    if (show === this.showTranslation) return;
    this.showTranslation = show;
    this.currentIdx = -1; // rebuild the stack to add/remove the sub-line
  }

  setDoc(doc: LyricsDoc | null): void {
    this.currentIdx = -1;
    this.wordSpans = [];
    this.prevActive = -1;
    this.annVersion += 1;
    this.container.innerHTML = "";
    this.currentWrapper = null;
    if (!doc || doc.lines.length === 0) {
      this.prepared = [];
      this.plain = doc?.plain ?? null;
      this.renderPlain();
      return;
    }
    this.plain = null;
    this.prepared = doc.lines.map((line) => ({
      line,
      words:
        line.words && line.words.length > 0
          ? line.words
          : synthesizeWords(line.text, line.start, line.end),
      // Bundled translation (e.g. NetEase tlyric), if present.
      translation: line.translation,
    }));
    void this.annotateAll();
  }

  /** Show a status message (searching / no lyrics / …) inside the glass box,
   *  styled like a line so it aligns with the overlay chrome. */
  setMessage(text: string | null): void {
    this.currentIdx = -1;
    this.prepared = [];
    this.plain = null;
    this.wordSpans = [];
    this.currentWrapper = null;
    this.annVersion += 1;
    this.container.innerHTML = "";
    if (text) {
      const wrapper = document.createElement("div");
      wrapper.className = "stack mounted";
      const line = document.createElement("div");
      line.className = "lyric-line current status-line";
      line.textContent = text;
      wrapper.appendChild(line);
      this.container.appendChild(wrapper);
    }
    this.scheduleFit();
  }

  /** Attach per-line translations (from the batched translate command). */
  setTranslations(translations: string[]): void {
    for (let i = 0; i < this.prepared.length; i++) {
      const t = translations[i];
      if (t) this.prepared[i]!.translation = t;
    }
    this.currentIdx = -1; // rebuild to show translations
  }

  /** Lazily romanize every line, then force a rebuild so sub-lines appear. */
  private async annotateAll(): Promise<void> {
    if (!romanizationActive(this.romanization) || this.prepared.length === 0) return;
    const version = ++this.annVersion;
    const lines = this.prepared;
    for (const p of lines) {
      const ann = await annotate(p.line.text, this.romanization);
      if (version !== this.annVersion) return; // superseded
      p.romaji = ann.romaji;
      p.furiganaHtml = ann.furiganaHtml;
    }
    this.currentIdx = -1; // rebuild to show romanization
  }

  /** Update the view for playback position `pos` (ms). */
  render(pos: number): void {
    if (this.prepared.length === 0) return;
    const idx = this.lineIndexAt(pos);
    if (idx !== this.currentIdx) {
      this.currentIdx = idx;
      if (idx < 0) this.clearStack();
      else this.rebuildStack(idx);
    }
    if (idx < 0) return;
    if (this.layout.animation === "fill") this.updateFill(pos);
    else if (this.layout.animation === "spotlight") this.updateSpotlight(pos);
  }

  private lineIndexAt(pos: number): number {
    // Before the first line starts (long intro), show nothing — otherwise the
    // first line would appear during the whole pre-roll.
    if (this.prepared.length === 0 || pos < this.prepared[0]!.line.start) return -1;
    let lo = 0;
    let hi = this.prepared.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.prepared[mid]!.line.start <= pos) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** Fade out the current stack, leaving the box empty (intro pre-roll). */
  private clearStack(): void {
    this.wordSpans = [];
    this.prevActive = -1;
    const old = this.currentWrapper;
    if (old) {
      old.classList.add("leaving");
      window.setTimeout(() => old.remove(), 200);
    }
    this.currentWrapper = null;
  }

  private renderPlain(): void {
    if (this.plain === null) return;
    // Unsynced lyrics have no timestamps, so there's nothing to follow. Dumping
    // the whole song into a single-line bar just fills it with stacked text, so
    // say so instead and leave the bar readable.
    const wrapper = document.createElement("div");
    wrapper.className = "stack mounted";
    const line = document.createElement("div");
    line.className = "lyric-line current status-line";
    line.textContent = "♪ unsynced lyrics only";
    wrapper.appendChild(line);
    this.container.appendChild(wrapper);
    this.currentWrapper = wrapper;
    this.scheduleFit();
  }

  private rebuildStack(idx: number): void {
    this.wordSpans = [];
    this.prevActive = -1;

    // Drop any stacks still lingering from earlier fades (rapid line changes can
    // queue several); only the outgoing current stack should crossfade. Without
    // this, fast songs leave a pile of half-faded lines stacked on the box.
    for (const node of Array.from(this.container.querySelectorAll(".stack"))) {
      if (node !== this.currentWrapper) node.remove();
    }

    // Build the new line stack into its own layer, then crossfade over the old
    // one (fade current line out while the next fades in).
    const wrapper = document.createElement("div");
    wrapper.className = "stack";

    const start = Math.max(0, idx - this.layout.before);
    const end = Math.min(this.prepared.length - 1, idx + this.layout.after);
    for (let i = start; i <= end; i++) {
      const p = this.prepared[i]!;
      const el = document.createElement("div");
      el.className = i === idx ? "lyric-line current" : "lyric-line context";
      this.buildLine(el, p, i === idx);
      wrapper.appendChild(el);
      // Sub-lines (romaji / translation) hang off the CURRENT line only. On the
      // faint prev/next context lines they'd triple the row count and force the
      // auto-fit to shrink everything to an unreadable size.
      if (i === idx) {
        if (p.romaji) this.appendSubLine(wrapper, p.romaji, "romaji-line", true);
        if (p.translation && this.showTranslation) {
          // Some providers bake a transliteration into the translation as
          // "【romaji】 english"; show each on its own line. Skip the bracketed
          // romaji if we already produced our own romanization above.
          const { roman, text } = splitTranslation(p.translation);
          if (roman && !p.romaji) this.appendSubLine(wrapper, roman, "romaji-line", true);
          this.appendSubLine(wrapper, text, "trans-line", true);
        }
      }
    }

    this.container.appendChild(wrapper);
    requestAnimationFrame(() => wrapper.classList.add("mounted"));
    this.scheduleFit();

    const old = this.currentWrapper;
    if (old) {
      old.classList.add("leaving");
      window.setTimeout(() => old.remove(), 200);
    }
    this.currentWrapper = wrapper;
  }

  private appendSubLine(parent: HTMLElement, text: string, cls: string, isCurrent: boolean): void {
    const el = document.createElement("div");
    el.className = `${cls} ${isCurrent ? "current" : "context"}`;
    el.textContent = text;
    parent.appendChild(el);
  }

  private buildLine(el: HTMLElement, p: PreparedLine, isCurrent: boolean): void {
    // Furigana (ruby) is rendered on the static text layer; word fill is
    // disabled for that line (whole-line highlight instead) — combining ruby
    // with progressive gradient fill is intentionally avoided.
    if (p.furiganaHtml) {
      el.innerHTML = p.furiganaHtml;
      if (isCurrent) el.classList.add("no-fill");
    } else if (isCurrent) {
      this.buildWordSpans(el, p.words);
    } else {
      el.textContent = p.line.text;
    }
  }

  private buildWordSpans(lineEl: HTMLElement, words: LyricWord[]): void {
    // fade = legacy whole-line fill (start filled); every other mode starts flat
    // in the base color and is driven per-frame (fill sweep / spotlight pop).
    const startFilled = this.layout.animation === "fade";
    for (const w of words) {
      const span = document.createElement("span");
      span.className = "lyric-word";
      span.textContent = w.text;
      span.style.setProperty("--p", startFilled ? "1" : "0");
      lineEl.appendChild(span);
      this.wordSpans.push(span);
    }
  }

  private updateFill(pos: number): void {
    const words = this.prepared[this.currentIdx]?.words;
    if (!words || this.wordSpans.length === 0) return;

    // Active word = last word whose start <= pos.
    let active = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i]!.start <= pos) active = i;
      else break;
    }

    if (active > this.prevActive) {
      for (let k = Math.max(0, this.prevActive); k < active; k++) {
        this.wordSpans[k]?.style.setProperty("--p", "1");
      }
    } else if (active < this.prevActive) {
      for (let k = active + 1; k <= this.prevActive; k++) {
        this.wordSpans[k]?.style.setProperty("--p", "0");
      }
    }

    if (active >= 0) {
      const w = words[active]!;
      const span = this.wordSpans[active];
      const frac = w.end > w.start ? Math.min(1, Math.max(0, (pos - w.start) / (w.end - w.start))) : 1;
      span?.style.setProperty("--p", String(frac));
    }
    this.prevActive = active;
  }

  /** Spotlight: the single active word snaps to the fill color and pops; all
   *  others sit flat in the base color. Only the changed words are touched. */
  private updateSpotlight(pos: number): void {
    const words = this.prepared[this.currentIdx]?.words;
    if (!words || this.wordSpans.length === 0) return;

    let active = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i]!.start <= pos) active = i;
      else break;
    }
    if (active === this.prevActive) return;

    const prev = this.wordSpans[this.prevActive];
    if (prev) {
      prev.style.setProperty("--p", "0");
      prev.classList.remove("active");
    }
    const cur = this.wordSpans[active];
    if (cur) {
      cur.style.setProperty("--p", "1");
      cur.classList.add("active");
    }
    this.prevActive = active;
  }
}
