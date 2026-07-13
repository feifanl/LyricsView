// Karaoke renderer: line stack (prev/current/next context) + progressive word
// fill. Per-frame style writes are limited to the active word for smoothness.
import type { AnimationStyle } from "../shared/settings";
import type { LyricsDoc, LyricLine, LyricWord } from "../shared/types";
import { synthesizeWords } from "./interpolate";

interface PreparedLine {
  line: LyricLine;
  words: LyricWord[];
}

export interface RenderLayout {
  before: number;
  after: number;
  animation: AnimationStyle;
}

export class Renderer {
  private prepared: PreparedLine[] = [];
  private plain: string | null = null;
  private currentIdx = -1;
  private wordSpans: HTMLElement[] = [];
  private prevActive = -1;
  private layout: RenderLayout = { before: 1, after: 1, animation: "fill" };

  constructor(private readonly container: HTMLElement) {}

  setLayout(layout: RenderLayout): void {
    this.layout = layout;
    this.currentIdx = -1; // force rebuild with new context counts
  }

  setDoc(doc: LyricsDoc | null): void {
    this.currentIdx = -1;
    this.wordSpans = [];
    this.prevActive = -1;
    this.container.innerHTML = "";
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
    }));
  }

  /** Update the view for playback position `pos` (ms). */
  render(pos: number): void {
    if (this.prepared.length === 0) return;
    const idx = this.lineIndexAt(pos);
    if (idx !== this.currentIdx) {
      this.currentIdx = idx;
      this.rebuildStack(idx);
    }
    if (this.layout.animation === "fill") this.updateFill(pos);
  }

  private lineIndexAt(pos: number): number {
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

  private renderPlain(): void {
    if (this.plain === null) return;
    const block = document.createElement("div");
    block.className = "lyric-line plain-block";
    block.textContent = this.plain;
    this.container.appendChild(block);
  }

  private rebuildStack(idx: number): void {
    this.container.innerHTML = "";
    this.wordSpans = [];
    this.prevActive = -1;

    const start = Math.max(0, idx - this.layout.before);
    const end = Math.min(this.prepared.length - 1, idx + this.layout.after);
    for (let i = start; i <= end; i++) {
      const el = document.createElement("div");
      el.className = i === idx ? "lyric-line current" : "lyric-line context";
      if (i === idx) {
        this.buildWordSpans(el, this.prepared[i]!.words);
      } else {
        el.textContent = this.prepared[i]!.line.text;
      }
      this.container.appendChild(el);
      // Fade-in on (re)mount.
      requestAnimationFrame(() => el.classList.add("mounted"));
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
