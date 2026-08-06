// Karaoke renderer: line stack (prev/current/next context) + progressive word
// fill, with optional romanization sub-lines and Japanese furigana. Per-frame
// style writes are limited to the active word for smoothness.
import type { AnimationStyle, LyricForm, LyricLinesCfg, RomanizationCfg } from "../shared/settings";
import { DEFAULT_LYRIC_LINES } from "../shared/settings";
import type { LyricsDoc, LyricLine, LyricWord } from "../shared/types";
import { synthesizeWords } from "./interpolate";
import { furiganaFragment } from "./furigana";
import { annotate, expectsRomaji, romanizationActive } from "./romanize";
import { lineIndexAt, type LineSpan } from "./timeline";

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

/** How many lines a "no romaji found" notice appears on before it gives up for
 *  the rest of the track. The information is about the track, not the line, so
 *  repeating it under every line is noise — but saying it once is easy to miss.
 *  Removing the node (rather than fading it) lets the box shrink back. */
const MISSING_NOTICE_LINES = 3;

/** Split a provider translation that leads with a bracketed transliteration
 *  ("【romaji】 english" or "[romaji] english") into the two parts. Returns the
 *  whole string as `text` when there's no such prefix (or no trailing text). */
function splitTranslation(t: string): { roman?: string; text: string } {
  const m = t.match(/^\s*[【[]([^】\]]+)[】\]]\s*(.+)$/s);
  if (m && m[2]!.trim()) return { roman: m[1]!.trim(), text: m[2]!.trim() };
  return { text: t };
}

function sameRomanization(a: RomanizationCfg, b: RomanizationCfg): boolean {
  return (
    a.auto === b.auto &&
    a.ja === b.ja &&
    a.jaFurigana === b.jaFurigana &&
    a.zh === b.zh &&
    a.ko === b.ko &&
    a.ru === b.ru
  );
}

function sameLyricLines(a: LyricLinesCfg, b: LyricLinesCfg): boolean {
  return (
    a.layout === b.layout &&
    a.order.length === b.order.length &&
    a.order.every((f, i) => f === b.order[i]) &&
    a.order.every((f) => a.enabled[f] === b.enabled[f])
  );
}

export class Renderer {
  private prepared: PreparedLine[] = [];
  private plain: string | null = null;
  private currentIdx = -1;
  /** Set when the stack must be rebuilt even though the line hasn't changed
   *  (translations arrived, romanization finished, a form/layout setting moved).
   *  Kept separate from `currentIdx` so a same-line rebuild stays distinguishable
   *  from a line change: crossfading a line against itself renders it twice. */
  private dirty = false;
  private wordSpans: HTMLElement[] = [];
  private prevActive = -1;
  private layout: RenderLayout = { before: 1, after: 1, animation: "fill" };
  private romanization: RomanizationCfg = NO_ROMANIZATION;
  private annVersion = 0;
  private currentWrapper: HTMLElement | null = null;
  private showTranslation = false;
  private lyricLines: LyricLinesCfg = {
    order: [...DEFAULT_LYRIC_LINES.order],
    enabled: { ...DEFAULT_LYRIC_LINES.enabled },
    layout: DEFAULT_LYRIC_LINES.layout,
  };
  /** Which form "single" layout shows. Held as the form itself, not an index:
   *  the built items skip forms with no content on the current line, so an index
   *  into them means a different form from one line to the next. */
  private activeForm: LyricForm | null = null;
  private fitQueued = false;
  /** Lines the "no romaji found" notice has already been shown on, this track. */
  private missingNoticeLines = new Set<number>();
  /** Line start/end times, cached for the per-frame lookup in `render`. */
  private lineSpans: LineSpan[] = [];

  /** Reports, after every fit, how wide the current row wants to be and how much
   *  width it was given (CSS px). Lets the host widen the overlay window instead
   *  of letting the columns clip. `wants` is 0 when there are no side columns. */
  onFit?: (wants: number, avail: number) => void;

  constructor(private readonly container: HTMLElement) {
    // Refit when the window/bar is resized (e.g. dock height changed).
    const root = container.parentElement;
    if (root && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.scheduleFit()).observe(root);
    }
  }

  /** Coalesce fit passes to one per frame (measuring forces layout). Only for
   *  external triggers like resizes — a rebuilt stack fits synchronously, so it
   *  never gets painted once at the previous line's scale. */
  private scheduleFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fit();
    });
  }

  /** Start the crossfade of an outgoing stack, pinned to the font sizes it was
   *  laid out with. The sizes live on :root, so refitting for the incoming line
   *  would otherwise resize the fading line under it — which reads as the text
   *  flashing between two sizes. */
  private fadeOut(stack: HTMLElement): void {
    const cs = getComputedStyle(document.documentElement);
    stack.style.setProperty("--font-size", cs.getPropertyValue("--font-size"));
    stack.style.setProperty("--row-max", cs.getPropertyValue("--row-max"));
    stack.classList.add("leaving");
    window.setTimeout(() => stack.remove(), 200);
  }

  /** Shrink the font (and everything derived from it) until the content fits the
   *  bar, so a small bar height or big font never clips text or the box edges.
   *  --fit-scale multiplies --font-size-base; box padding is fixed, so refine a
   *  few times to converge.
   *
   *  Only the lyric line is fitted. The romaji/translation columns keep a fixed
   *  share of its size and clip their tail when there's no room: sizing them per
   *  line made them change size on every line change, which reads as flashing. */
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
    // The glass box's own padding/border and max-width cap eat into the space
    // the text may use; without this the row happily overflows the box.
    const bs = getComputedStyle(this.container);
    const boxY =
      parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom) + parseFloat(bs.borderTopWidth) + parseFloat(bs.borderBottomWidth);
    const boxX =
      parseFloat(bs.paddingLeft) + parseFloat(bs.paddingRight) + parseFloat(bs.borderLeftWidth) + parseFloat(bs.borderRightWidth);
    let capW = root.clientWidth - padX;
    if (bs.maxWidth.endsWith("%")) capW *= parseFloat(bs.maxWidth) / 100;
    else if (bs.maxWidth.endsWith("px")) capW = Math.min(capW, parseFloat(bs.maxWidth));
    const availH = root.clientHeight - padY - boxY - SAFETY * 2;
    const availW = capW - boxX - SAFETY * 2;
    if (availH <= 0 || availW <= 0) return;

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--fit-scale", "1");
    // Clamp the row to exactly what the fit budgets, so the columns clip at the
    // width the measurements assume instead of spilling past the box.
    rootStyle.setProperty("--row-max", `${availW}px`);

    // Measured with the side columns hidden: they never cost the lyric any size,
    // so the lyric is fitted exactly as if it were alone in the box.
    this.container.classList.add("measuring");
    this.shrinkToFit(1, availW, availH, rootStyle);
    this.container.classList.remove("measuring");

    this.onFit?.(this.rowNaturalWidth(), availW);
  }

  /** Width the current row wants before any clipping, or 0 when it has no side
   *  columns. They're clamped by the row's max-width, so their rects report the
   *  clipped width — scrollWidth is what they'd actually like to be. */
  private rowNaturalWidth(): number {
    const row = this.container.querySelector<HTMLElement>(".stack:not(.leaving) .sub-row.has-sides");
    if (!row) return 0;
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    let w = 0;
    for (const child of row.children) w += Math.max(child.scrollWidth, child.getBoundingClientRect().width);
    return w + gap * Math.max(0, row.children.length - 1);
  }

  /** Height of the tallest live stack. Measured from the element, not the
   *  container's scroll size: the box centers its content, so overflow spills
   *  out both sides and scrollHeight/Width under-report it. */
  private stackHeight(): number {
    let h = 0;
    for (const stack of this.container.querySelectorAll<HTMLElement>(".stack")) {
      if (stack.classList.contains("leaving")) continue;
      h = Math.max(h, stack.getBoundingClientRect().height);
    }
    return h;
  }

  /** Rendered width of the widest lyric line, ignoring the side columns. The
   *  lyric never shrinks in the flex row, so this is its natural width. */
  private lineWidth(): number {
    let w = 0;
    for (const el of this.container.querySelectorAll<HTMLElement>(".stack:not(.leaving) .lyric-line")) {
      w = Math.max(w, el.getBoundingClientRect().width);
    }
    return w;
  }

  private shrinkToFit(scale: number, availW: number, availH: number, rootStyle: CSSStyleDeclaration): number {
    for (let i = 0; i < 4; i++) {
      const needH = this.stackHeight();
      const needW = this.lineWidth();
      const step = Math.min(needH > availH ? availH / needH : 1, needW > availW ? availW / needW : 1);
      if (step >= 0.999) break;
      scale = Math.max(0.3, scale * step);
      rootStyle.setProperty("--fit-scale", String(scale));
    }
    return scale;
  }

  // The settings window broadcasts on every keystroke and slider tick, so each
  // of these setters can fire dozens of times a second while the user is just
  // dragging a colour. They must all be no-ops when nothing actually changed:
  // a forced rebuild costs a synchronous re-fit, and re-romanizing costs a full
  // pass over the document — enough, repeated, to lock the overlay up.
  setLayout(layout: RenderLayout): void {
    if (
      layout.before === this.layout.before &&
      layout.after === this.layout.after &&
      layout.animation === this.layout.animation
    ) {
      return;
    }
    this.layout = layout;
    this.dirty = true; // rebuild with new context counts
  }

  setRomanization(cfg: RomanizationCfg): void {
    if (sameRomanization(cfg, this.romanization)) return;
    this.romanization = cfg;
    if (!romanizationActive(cfg)) {
      // Turning romanization off has to drop what a previous pass produced,
      // otherwise stale romaji/furigana stays on screen until the next track.
      for (const p of this.prepared) {
        p.romaji = undefined;
        p.furiganaHtml = undefined;
      }
      this.annVersion += 1; // cancel any pass still running
      this.dirty = true;
      return;
    }
    void this.annotateAll();
  }

  /** Toggle the translated sub-line (Original vs Translated view). */
  setShowTranslation(show: boolean): void {
    if (show === this.showTranslation) return;
    this.showTranslation = show;
    this.dirty = true; // rebuild the stack to add/remove the sub-line
  }

  /** Which forms show, in what order, and the layout. */
  setLyricLines(cfg: LyricLinesCfg): void {
    if (sameLyricLines(cfg, this.lyricLines)) return;
    this.lyricLines = {
      order: [...cfg.order],
      enabled: { ...cfg.enabled },
      layout: cfg.layout,
    };
    // Drop a selection the user has since disabled.
    if (this.activeForm && !this.lyricLines.enabled[this.activeForm]) this.activeForm = null;
    this.dirty = true; // rebuild with the new form set / layout
  }

  /** Cycle which single form shows (only meaningful in "single" layout). Returns
   *  the newly-selected form, or null when cycling doesn't apply. */
  cycleForm(dir: 1 | -1): LyricForm | null {
    if (this.lyricLines.layout !== "single") return null;
    const forms = this.visibleForms();
    if (forms.length < 2) return null;
    const cur = this.activeForm ? forms.indexOf(this.activeForm) : 0;
    this.activeForm = forms[(Math.max(0, cur) + dir + forms.length) % forms.length]!;
    this.dirty = true; // rebuild to swap the shown form
    return this.activeForm;
  }

  /** Forms that are enabled, in display order (ignores per-line content). */
  private visibleForms(): LyricForm[] {
    return this.lyricLines.order.filter((f) => this.lyricLines.enabled[f]);
  }

  setDoc(doc: LyricsDoc | null): void {
    this.currentIdx = -1;
    this.dirty = false;
    this.wordSpans = [];
    this.prevActive = -1;
    this.annVersion += 1;
    this.container.replaceChildren();
    this.currentWrapper = null;
    this.setVacant(true); // until the first line (or the plain note) is built
    this.missingNoticeLines.clear(); // notices are budgeted per track
    if (!doc || doc.lines.length === 0) {
      this.prepared = [];
      this.lineSpans = [];
      this.plain = doc?.plain ?? null;
      this.renderPlain();
      return;
    }
    this.plain = null;
    this.lineSpans = doc.lines.map((l) => ({
      start: l.start,
      end: l.end,
      chars: l.text.trim().length,
    }));
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
    this.dirty = false;
    this.prepared = [];
    this.lineSpans = [];
    this.plain = null;
    this.wordSpans = [];
    this.currentWrapper = null;
    this.annVersion += 1;
    this.container.replaceChildren();
    this.setVacant(!text);
    if (text) {
      const wrapper = document.createElement("div");
      wrapper.className = "stack mounted";
      const line = document.createElement("div");
      line.className = "lyric-line current status-line";
      line.textContent = text;
      wrapper.appendChild(line);
      this.container.appendChild(wrapper);
      this.currentWrapper = wrapper;
    }
    this.fit();
  }

  /** Attach per-line translations (from the batched translate command). */
  setTranslations(translations: string[]): void {
    for (let i = 0; i < this.prepared.length; i++) {
      const t = translations[i];
      if (t) this.prepared[i]!.translation = t;
    }
    this.dirty = true; // rebuild to show translations
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
    this.dirty = true; // rebuild to show romanization
  }

  /** Update the view for playback position `pos` (ms). */
  render(pos: number): void {
    if (this.prepared.length === 0) return;
    // Cached rather than mapped per frame — this runs on every animation frame.
    const idx = lineIndexAt(this.lineSpans, pos);
    if (idx !== this.currentIdx || this.dirty) {
      const sameLine = idx === this.currentIdx;
      this.currentIdx = idx;
      this.dirty = false;
      if (idx < 0) this.clearStack();
      else this.rebuildStack(idx, sameLine);
    }
    if (idx < 0) return;
    if (this.layout.animation === "fill") this.updateFill(pos);
    else if (this.layout.animation === "spotlight") this.updateSpotlight(pos);
  }

  /** Fade out the current stack, leaving the box empty (intro, instrumental
   *  break, outro). */
  private clearStack(): void {
    this.wordSpans = [];
    this.prevActive = -1;
    if (this.currentWrapper) this.fadeOut(this.currentWrapper);
    this.currentWrapper = null;
    this.setVacant(true);
  }

  /** Fade the whole box (background pill included) in or out. */
  private setVacant(on: boolean): void {
    this.container.classList.toggle("vacant", on);
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
    this.setVacant(false);
    this.fit();
  }

  /** `sameLine` = re-rendering the line already on screen (new translation,
   *  romanization or form setting) rather than advancing to the next one. */
  private rebuildStack(idx: number, sameLine = false): void {
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
      if (i !== idx) {
        // Romaji/translation hang off the CURRENT line only; on the faint
        // prev/next context lines they'd just add noise.
        const el = document.createElement("div");
        el.className = "lyric-line context";
        this.buildLine(el, p, false);
        wrapper.appendChild(el);
        continue;
      }
      this.buildCurrentForms(wrapper, p, idx);
    }

    // A crossfade only makes sense between two different lines. Fading a line
    // against a fresh copy of itself just shows the same text twice — once dim
    // and pinned at the old size, once live — which reads as a doubled lyric.
    // Same line: swap instantly, already mounted so it doesn't fade in either.
    if (sameLine) {
      this.currentWrapper?.remove();
      wrapper.classList.add("mounted");
    } else if (this.currentWrapper) {
      // Pin the outgoing stack before refitting, so the fit below only resizes
      // the incoming one.
      this.fadeOut(this.currentWrapper);
    }
    this.currentWrapper = wrapper;

    this.container.appendChild(wrapper);
    this.setVacant(false);
    // Fit synchronously: at rAF the new stack would already have been painted
    // once at the previous line's size, which is the flash.
    this.fit();
    if (!sameLine) requestAnimationFrame(() => wrapper.classList.add("mounted"));
  }

  /** Build the current line's forms (romaji / original / translation) in the
   *  user's chosen order and layout, appending row(s) to the stack wrapper:
   *   - inline:  all forms on one row (never grows the stack taller).
   *   - stacked: each form on its own row (bulkier, wraps less).
   *   - single:  just one form, chosen by the hotkey-driven active form. */
  private buildCurrentForms(wrapper: HTMLElement, p: PreparedLine, idx: number): void {
    this.wordSpans = [];

    let romaji = p.romaji;
    let translation: string | undefined;
    if (p.translation && this.showTranslation) {
      // Some providers bake a transliteration into the translation as
      // "【romaji】 english"; split it out. Skip the bracketed romaji if we
      // already produced our own romanization.
      const { roman, text } = splitTranslation(p.translation);
      if (roman && !romaji) romaji = roman;
      translation = text;
    }

    // Build a node for each enabled form that has content, in configured order.
    // Original is the karaoke line (word spans / furigana); the others are text.
    // Keyed by form as well as ordered: "single" layout has to pick the node for
    // a specific form, and a plain index would land on whatever survived the
    // content checks on this particular line.
    const byForm = new Map<LyricForm, HTMLElement>();
    const items: HTMLElement[] = [];
    const add = (form: LyricForm, el: HTMLElement): void => {
      byForm.set(form, el);
      items.push(el);
    };
    for (const form of this.lyricLines.order) {
      if (!this.lyricLines.enabled[form]) continue;
      if (form === "original") {
        const el = document.createElement("div");
        el.className = "lyric-line current";
        this.buildLine(el, p, true); // populates this.wordSpans
        add(form, el);
      } else if (form === "romaji") {
        if (romaji) add(form, this.subItem(romaji, "romaji-line"));
        else if (
          !p.furiganaHtml &&
          expectsRomaji(p.line.text, this.romanization) &&
          this.allowMissingNotice(idx)
        ) {
          // Only when the line's own script should have romanized (a real miss).
          add(form, this.subItem("no romaji found", "missing-line"));
        }
      } else if (form === "translation") {
        if (translation) add(form, this.subItem(translation, "trans-line"));
      }
    }
    // Never show a totally empty box: fall back to the original line.
    if (items.length === 0) {
      const el = document.createElement("div");
      el.className = "lyric-line current";
      this.buildLine(el, p, true);
      add("original", el);
    }

    if (this.lyricLines.layout === "stacked") {
      // Group the form rows so the stack's line gap applies once (around the
      // group), and the forms themselves sit tight together.
      const group = document.createElement("div");
      group.className = "forms-stack";
      for (const node of items) {
        const row = document.createElement("div");
        row.className = "sub-row stacked-row";
        row.appendChild(node);
        group.appendChild(row);
      }
      wrapper.appendChild(group);
      return;
    }

    const row = document.createElement("div");
    row.className = "sub-row";
    if (this.lyricLines.layout === "single") {
      // Falling back when the chosen form has nothing on this line must not
      // change the selection — otherwise one line without a translation would
      // silently switch the user onto the original for the rest of the song.
      const chosen = (this.activeForm && byForm.get(this.activeForm)) || items[0]!;
      row.appendChild(chosen);
    } else {
      for (const node of items) row.appendChild(node);
      // Marks the row as multi-column so nothing in it wraps (see overlay.css).
      if (items.length > 1) row.classList.add("has-sides");
    }
    wrapper.appendChild(row);
  }

  /** Whether line `idx` may carry a "missing" notice. The budget counts distinct
   *  lines, not renders, so re-rendering the same line (a settings change, a
   *  romanization pass finishing) never spends it. */
  private allowMissingNotice(idx: number): boolean {
    if (this.missingNoticeLines.has(idx)) return true;
    if (this.missingNoticeLines.size >= MISSING_NOTICE_LINES) return false;
    this.missingNoticeLines.add(idx);
    return true;
  }

  private subItem(text: string, cls: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `${cls} current`;
    el.textContent = text;
    return el;
  }

  private buildLine(el: HTMLElement, p: PreparedLine, isCurrent: boolean): void {
    // Furigana (ruby) is rendered on the static text layer; word fill is
    // disabled for that line (whole-line highlight instead) — combining ruby
    // with progressive gradient fill is intentionally avoided.
    if (p.furiganaHtml) {
      // Built as nodes, never assigned as markup: kuroshiro interpolates the
      // lyric into its ruby template unescaped, and lyrics come from providers
      // whose catalogues anyone can edit. See furigana.ts.
      el.replaceChildren(furiganaFragment(p.furiganaHtml));
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
