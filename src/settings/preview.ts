// In-app live preview of the overlay. Renders a sample lyric line on a frosted
// glass card and sweeps it word-by-word so color / font / highlight changes are
// visible without music playing. Mirrors the real overlay's fill/spotlight logic.
import type { AnimationStyle, Preset } from "../shared/settings";

const SAMPLE = "The city lights are calling out my name";
const WORD_MS = 460; // per-word dwell in the demo loop
const TAIL_MS = 1100; // pause before the line restarts

const MODE_LABEL: Record<AnimationStyle, string> = {
  none: "No highlight",
  fill: "Karaoke sweep",
  spotlight: "Spotlight word",
  fade: "Line highlight",
};

interface Timing {
  start: number;
  end: number;
}

export class LyricPreview {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private line: HTMLElement;
  private caption: HTMLElement;
  private words: HTMLElement[] = [];
  private timings: Timing[] = [];
  private total = WORD_MS + TAIL_MS;
  private mode: AnimationStyle = "fill";
  private t0 = performance.now();
  private raf = 0;

  constructor() {
    this.card = document.createElement("div");
    this.card.className = "lp-card";
    this.line = document.createElement("div");
    this.line.className = "lp-line";
    this.card.append(this.line);

    const stage = document.createElement("div");
    stage.className = "lp-stage";
    stage.append(this.card);

    this.caption = document.createElement("div");
    this.caption.className = "lp-caption";

    this.el = document.createElement("div");
    this.el.className = "lp-wrap";
    this.el.append(stage, this.caption);

    this.buildWords();
    this.raf = requestAnimationFrame(this.tick);
  }

  private buildWords(): void {
    const words = SAMPLE.split(" ");
    this.line.replaceChildren();
    this.words = [];
    this.timings = [];
    words.forEach((text, i) => {
      const span = document.createElement("span");
      span.className = "lp-word";
      span.textContent = i < words.length - 1 ? text + " " : text;
      this.line.append(span);
      this.words.push(span);
      this.timings.push({ start: i * WORD_MS, end: (i + 1) * WORD_MS });
    });
    this.total = words.length * WORD_MS + TAIL_MS;
  }

  /** Re-skin the preview from a preset (called on every control edit). */
  update(p: Preset): void {
    this.mode = p.animation;
    const s = this.card.style;
    s.setProperty("--lp-base", p.colors.base);
    s.setProperty("--lp-fill", p.colors.fill);
    s.setProperty("--lp-bgcolor", p.backgroundColor);
    s.opacity = String(p.opacity);

    this.line.style.fontFamily = `"${p.font.family}", system-ui, sans-serif`;
    this.line.style.fontSize = `${Math.min(p.font.sizePx, 40)}px`;
    this.line.style.fontWeight = String(p.font.weight);
    this.line.style.opacity = String(p.textOpacity ?? 1);
    this.line.style.filter = `brightness(${p.textBrightness ?? 1})`;

    this.card.classList.toggle("lp-shadow", p.colors.textShadow);
    this.card.classList.toggle("lp-outline", p.colors.outline);
    this.card.classList.remove("lp-bg-none", "lp-bg-glass", "lp-bg-solid");
    this.card.classList.add(`lp-bg-${p.background}`);

    this.caption.textContent = `Live preview · ${MODE_LABEL[p.animation]}`;
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private tick = (): void => {
    const t = (performance.now() - this.t0) % this.total;
    this.paint(t);
    this.raf = requestAnimationFrame(this.tick);
  };

  private paint(t: number): void {
    let active = -1;
    for (let i = 0; i < this.timings.length; i++) {
      if (this.timings[i]!.start <= t) active = i;
      else break;
    }
    if (t >= this.timings.length * WORD_MS) active = this.timings.length - 1; // hold on tail

    for (let i = 0; i < this.words.length; i++) {
      const span = this.words[i]!;
      const isActive = i === active && this.mode === "spotlight";
      span.classList.toggle("active", isActive);

      let p = 0;
      if (this.mode === "none") {
        p = 0;
      } else if (this.mode === "spotlight") {
        p = i === active ? 1 : 0;
      } else {
        // fill (karaoke) — progressive within the active word, full for past ones
        const { start, end } = this.timings[i]!;
        p = t >= end ? 1 : t <= start ? 0 : (t - start) / (end - start);
      }
      span.style.setProperty("--p", p.toFixed(3));
    }
  }
}
