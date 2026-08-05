import type { SourceId } from "./types";

export type HotkeyAction =
  | "toggleOverlay"
  | "toggleEditMode"
  | "offsetMinus"
  | "offsetPlus"
  | "driftMinus"
  | "driftPlus"
  | "prevLine"
  | "nextLine"
  | "reloadLyrics"
  | "cycleFormPrev"
  | "cycleFormNext";

/** The three renderable forms of a lyric line. */
export type LyricForm = "romaji" | "original" | "translation";

export type LyricLayout = "inline" | "stacked" | "single";

export interface LyricLinesCfg {
  /** All three forms in display order (top-to-bottom / left-to-right). */
  order: LyricForm[];
  /** Which forms are shown at all. */
  enabled: Record<LyricForm, boolean>;
  /** inline = one row; stacked = a row each; single = one form, cycled by hotkey. */
  layout: LyricLayout;
}

export const DEFAULT_LYRIC_LINES: LyricLinesCfg = {
  order: ["romaji", "original", "translation"],
  enabled: { romaji: true, original: true, translation: true },
  layout: "inline",
};

export interface RomanizationCfg {
  /** Auto-romanize any detected non-Latin script (JA/ZH/KO/RU). When on it
   *  covers all four; the per-language flags below are advanced overrides for
   *  enabling a single script while auto is off. */
  auto: boolean;
  ja: boolean;
  jaFurigana: boolean;
  zh: boolean;
  ko: boolean;
  ru: boolean;
}

/** Any romanization at all — `auto` plus the per-script overrides. */
export function romanizationOn(cfg: RomanizationCfg): boolean {
  return cfg.auto || cfg.ja || cfg.zh || cfg.ko || cfg.ru;
}

export const ROMANIZATION_OFF: RomanizationCfg = {
  auto: false,
  ja: false,
  jaFurigana: false,
  zh: false,
  ko: false,
  ru: false,
};

export type BackgroundStyle = "none" | "glass" | "solid";
// Highlight modes: none = flat line, fill = progressive karaoke sweep,
// spotlight = pop the single word being sung. (fade = legacy whole-line.)
export type AnimationStyle = "fill" | "spotlight" | "fade" | "none";
export type ContextCount = 0 | 1 | 2;
/** Float = free position (edit-mode drag). Top/bottom = full-width edge bar. */
export type DockMode = "float" | "top" | "bottom";

export interface Preset {
  name: string;
  monitor: number | null;
  /** Ignored while docked; the bar is pinned to the monitor edge. */
  dock: DockMode;
  position: { x: number; y: number } | null;
  size: { w: number; h: number };
  font: { family: string; sizePx: number; weight: number };
  colors: { base: string; fill: string; textShadow: boolean; outline: boolean };
  /** Text-only opacity (0.1–1) and brightness (0.5–1.5), independent of the
   *  background box, which uses `opacity`. */
  textOpacity: number;
  textBrightness: number;
  opacity: number;
  background: BackgroundStyle;
  backgroundColor: string;
  contextLines: { before: ContextCount; after: ContextCount };
  lineSpacing: number;
  animation: AnimationStyle;
}

export interface Settings {
  /** Bumped to migrate built-in presets/defaults on load. */
  schemaVersion: number;
  activePreset: string;
  presets: Record<string, Preset>;
  providerOrder: SourceId[];
  providersEnabled: Record<SourceId, boolean>;
  preferWordLevel: boolean;
  appleMusic: {
    mediaUserToken: string;
    developerToken: string;
    storefront: string;
  };
  translation: {
    /** Show the translated line under the lyrics (Original vs Translated view).
     *  Built-in provider translations are preferred; AI is a fallback. */
    show: boolean;
    /** Allow AI translation to fill lines with no built-in translation. */
    enabled: boolean;
    provider: "deepl" | "google" | "openai";
    apiKey: string;
    baseUrl?: string;
    model?: string;
    targetLang: string;
  };
  romanization: RomanizationCfg;
  /** Which lyric forms show, their order, and the layout (see LyricLinesCfg). */
  lyricLines: LyricLinesCfg;
  hotkeys: Record<HotkeyAction, string>;
  autoHide: { enabled: boolean; delaySec: number };
  globalOffsetMs: number;
  /** Settings-UI theme; overlay colors are explicit, not themed. */
  uiTheme: "light" | "dark";
}

export const SCHEMA_VERSION = 6;

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggleOverlay: "Alt+Shift+L",
  toggleEditMode: "Alt+Shift+E",
  offsetMinus: "Alt+Shift+[",
  offsetPlus: "Alt+Shift+]",
  driftMinus: "Alt+Shift+,",
  driftPlus: "Alt+Shift+.",
  prevLine: "Alt+Shift+Left",
  nextLine: "Alt+Shift+Right",
  reloadLyrics: "Alt+Shift+R",
  cycleFormPrev: "Alt+Shift+Up",
  cycleFormNext: "Alt+Shift+Down",
};

function gamingPreset(): Preset {
  return {
    name: "Gaming",
    monitor: null,
    dock: "float",
    position: null,
    size: { w: 520, h: 84 },
    font: { family: "Segoe UI", sizePx: 24, weight: 600 },
    colors: { base: "#ffffffcc", fill: "#7dd3fc", textShadow: true, outline: false },
    textOpacity: 1,
    textBrightness: 1,
    opacity: 0.6,
    background: "none",
    backgroundColor: "#000000aa",
    contextLines: { before: 0, after: 0 },
    lineSpacing: 1.2,
    animation: "fill",
  };
}

function karaokePreset(): Preset {
  return {
    name: "Karaoke",
    monitor: null,
    dock: "float",
    position: null,
    size: { w: 900, h: 260 },
    font: { family: "Segoe UI", sizePx: 40, weight: 700 },
    colors: { base: "#ffffffdd", fill: "#ffd54f", textShadow: true, outline: false },
    textOpacity: 1,
    textBrightness: 1,
    opacity: 1,
    background: "glass",
    backgroundColor: "rgba(18,18,26,0.28)",
    contextLines: { before: 1, after: 1 },
    lineSpacing: 1.35,
    animation: "fill",
  };
}

// Liquid-glass single-line bar, docked at the top — the default look.
function glassBarPreset(): Preset {
  return {
    name: "Glass Bar",
    monitor: null,
    dock: "top",
    position: null,
    size: { w: 1120, h: 88 },
    font: { family: "Segoe UI", sizePx: 27, weight: 600 },
    colors: { base: "#ffffffe6", fill: "#8be9fd", textShadow: false, outline: false },
    textOpacity: 1,
    textBrightness: 1,
    opacity: 1,
    background: "glass",
    backgroundColor: "rgba(18,18,26,0.28)",
    contextLines: { before: 0, after: 0 },
    lineSpacing: 1.15,
    animation: "fill",
  };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    activePreset: "Glass Bar",
    presets: {
      "Glass Bar": glassBarPreset(),
      Gaming: gamingPreset(),
      Karaoke: karaokePreset(),
    },
    providerOrder: ["lrclib", "musixmatch", "netease", "applemusic"],
    // Only LRCLIB is on out of the box. It is an open, public, no-auth lyrics
    // API meant to be used this way. The others reach undocumented endpoints
    // belonging to commercial services — using them is the user's decision to
    // make with their own account, not a default this app makes for them.
    // Existing configs keep whatever the user already chose (see mergeDefaults).
    providersEnabled: {
      lrclib: true,
      musixmatch: false,
      netease: false,
      applemusic: false,
      manual: true,
    },
    preferWordLevel: true,
    appleMusic: { mediaUserToken: "", developerToken: "", storefront: "us" },
    translation: {
      // On by default: non-English songs that ship a built-in translation show
      // original + translation automatically. Songs with no translation show
      // nothing extra, so English lyrics stay clean.
      show: true,
      enabled: false,
      provider: "deepl",
      apiKey: "",
      baseUrl: "",
      model: "",
      targetLang: "en",
    },
    romanization: { auto: false, ja: false, jaFurigana: false, zh: false, ko: false, ru: false },
    lyricLines: {
      order: [...DEFAULT_LYRIC_LINES.order],
      enabled: { ...DEFAULT_LYRIC_LINES.enabled },
      layout: DEFAULT_LYRIC_LINES.layout,
    },
    hotkeys: { ...DEFAULT_HOTKEYS },
    autoHide: { enabled: true, delaySec: 5 },
    globalOffsetMs: 0,
    uiTheme: "dark",
  };
}

export function activePreset(s: Settings): Preset {
  return s.presets[s.activePreset] ?? glassBarPreset();
}
