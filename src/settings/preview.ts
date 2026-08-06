// In-app live preview of the overlay. Renders a sample lyric line on a frosted
// glass card and sweeps it word-by-word so color / font / highlight changes are
// visible without music playing. Mirrors the real overlay's fill/spotlight logic.
import type { AnimationStyle, Preset } from "../shared/settings";

const SAMPLE = "The city lights are calling out my name";

// Mirrors .lyrics.bg-glass and .lyric-line in overlay/overlay.css. The preview is
// only honest while these match; change them there and change them here.
const PILL_PAD_Y = 16;
const PILL_PAD_X = 40;
const PILL_RADIUS = 26;
const LINE_HEIGHT = 1.25;
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
  private stage: HTMLElement;
  private last: Preset | null = null;
  private resizeObs: ResizeObserver | null = null;

  constructor() {
    this.card = document.createElement("div");
    this.card.className = "lp-card";
    this.line = document.createElement("div");
    this.line.className = "lp-line";
    this.card.append(this.line);

    const stage = document.createElement("div");
    stage.className = "lp-stage";
    stage.append(this.card);
    this.stage = stage;

    // The scale depends on the stage's pixel width, which is zero until layout
    // and changes whenever the settings window is resized.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => {
        if (this.last) this.applyScale(this.last);
      });
      this.resizeObs.observe(stage);
    }

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
    this.last = p;
    this.mode = p.animation;
    const s = this.card.style;
    s.setProperty("--lp-base", p.colors.base);
    s.setProperty("--lp-fill", p.colors.fill);
    s.setProperty("--lp-bgcolor", p.backgroundColor);
    s.opacity = String(p.opacity);

    this.line.style.fontFamily = `"${p.font.family}", system-ui, sans-serif`;
    this.line.style.fontWeight = String(p.font.weight);
    this.line.style.opacity = String(p.textOpacity ?? 1);
    this.line.style.filter = `brightness(${p.textBrightness ?? 1})`;
    this.applyScale(p);

    this.card.classList.toggle("lp-shadow", p.colors.textShadow);
    this.card.classList.toggle("lp-outline", p.colors.outline);
    this.card.classList.remove("lp-bg-none", "lp-bg-glass", "lp-bg-solid");
    this.card.classList.add(`lp-bg-${p.background}`);

    this.caption.textContent = `Live preview · ${MODE_LABEL[p.animation]}`;
  }

  /**
   * Draw the card the way the overlay actually behaves: the pill hugs its text
   * and the window grows sideways to hold it (see overlay/autowidth.ts). The bar
   * height is the fixed dimension; width follows the line.
   *
   * Modelling it as a fixed-width bar was wrong in both directions — small type
   * floated in a box that never shrank, and large type got squeezed to fit a
   * width the real overlay would simply have grown past.
   *
   * The stage stands in for the monitor. Text wide enough to overflow it is the
   * preview's version of hitting the screen edge, and the whole model scales
   * down together rather than the type alone, so proportions stay honest.
   */
  private applyScale(p: Preset): void {
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    if (stageW === 0 || stageH === 0) return; // pre-layout; ResizeObserver retries

    // The stage stands in for the whole screen, so the scale is screen-relative.
    // Deriving it from the bar height instead made the card hit the stage edge
    // far sooner than the overlay hits the monitor edge, so every size past ~40
    // came out identically capped — the "big fonts get squeezed" symptom.
    const screenW = window.screen?.width || 1920;
    const scale = (stageW * 0.98) / screenW;

    // The pill is content-sized in both directions — the preset's height is the
    // transparent window it floats in, not the box you see. Using that height
    // here is what made the preview cramped: the type filled a box the overlay
    // would have padded generously. These constants mirror .lyrics.bg-glass and
    // .lyric-line in overlay.css; they must move together.
    this.card.style.height = "auto";
    this.card.style.padding = `${PILL_PAD_Y * scale}px ${PILL_PAD_X * scale}px`;
    this.card.style.borderRadius = `${PILL_RADIUS * scale}px`;
    this.line.style.lineHeight = String(LINE_HEIGHT);
    this.line.style.fontSize = `${p.font.sizePx * scale}px`;

    // Reaching the stage edge now genuinely means reaching the monitor edge:
    // there the window stops widening and the overlay's fit() shrinks the type
    // instead — so shrink type alone, never the pill's padding.
    const maxW = stageW * 0.98;
    const w = this.card.getBoundingClientRect().width;
    if (w > maxW && w > 0) {
      const padPx = 2 * PILL_PAD_X * scale;
      const textW = Math.max(1, w - padPx);
      this.line.style.fontSize = `${p.font.sizePx * scale * ((maxW - padPx) / textW)}px`;
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
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
