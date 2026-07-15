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

const NO_ROMANIZATION: RomanizationCfg = { ja: false, jaFurigana: false, zh: false, ko: false, ru: false };

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

  constructor(private readonly container: HTMLElement) {}

  setLayout(layout: RenderLayout): void {
    this.layout = layout;
    this.currentIdx = -1; // force rebuild with new context counts
  }

  setRomanization(cfg: RomanizationCfg): void {
    this.romanization = cfg;
    void this.annotateAll();
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
    if (idx >= 0 && this.layout.animation === "fill") this.updateFill(pos);
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
      window.setTimeout(() => old.remove(), 380);
    }
    this.currentWrapper = null;
  }

  private renderPlain(): void {
    if (this.plain === null) return;
    const block = document.createElement("div");
    block.className = "lyric-line plain-block";
    block.textContent = this.plain;
    this.container.appendChild(block);
  }

  private rebuildStack(idx: number): void {
    this.wordSpans = [];
    this.prevActive = -1;

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
      if (p.romaji) this.appendSubLine(wrapper, p.romaji, "romaji-line", i === idx);
      if (p.translation) this.appendSubLine(wrapper, p.translation, "trans-line", i === idx);
    }

    this.container.appendChild(wrapper);
    requestAnimationFrame(() => wrapper.classList.add("mounted"));

    const old = this.currentWrapper;
    if (old) {
      old.classList.add("leaving");
      window.setTimeout(() => old.remove(), 380);
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
    const full = this.layout.animation !== "fill"; // fade/none: fill instantly
    for (const w of words) {
      const span = document.createElement("span");
      span.className = "lyric-word";
      span.textContent = w.text;
      span.style.setProperty("--p", full ? "1" : "0");
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
}
