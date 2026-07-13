import type { SourceId } from "./types";

export type HotkeyAction =
  | "toggleOverlay"
  | "toggleEditMode"
  | "offsetMinus"
  | "offsetPlus"
  | "prevLine"
  | "nextLine"
  | "reloadLyrics";

export interface RomanizationCfg {
  ja: boolean;
  jaFurigana: boolean;
  zh: boolean;
  ko: boolean;
  ru: boolean;
}

export type BackgroundStyle = "none" | "glass" | "solid";
export type AnimationStyle = "fill" | "fade" | "none";
export type ContextCount = 0 | 1 | 2;

export interface Preset {
  name: string;
  monitor: number | null;
  position: { x: number; y: number } | null;
  size: { w: number; h: number };
  font: { family: string; sizePx: number; weight: number };
  colors: { base: string; fill: string; textShadow: boolean; outline: boolean };
  opacity: number;
  background: BackgroundStyle;
  backgroundColor: string;
  contextLines: { before: ContextCount; after: ContextCount };
  lineSpacing: number;
  animation: AnimationStyle;
}

export interface Settings {
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
    enabled: boolean;
    provider: "deepl" | "google" | "openai";
    apiKey: string;
    baseUrl?: string;
    model?: string;
    targetLang: string;
  };
  romanization: RomanizationCfg;
  hotkeys: Record<HotkeyAction, string>;
  autoHide: { enabled: boolean; delaySec: number };
  globalOffsetMs: number;
  /** Settings-UI theme; overlay colors are explicit, not themed. */
  uiTheme: "light" | "dark";
}

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggleOverlay: "Alt+Shift+L",
  toggleEditMode: "Alt+Shift+E",
  offsetMinus: "Alt+Shift+[",
  offsetPlus: "Alt+Shift+]",
  prevLine: "Alt+Shift+Left",
  nextLine: "Alt+Shift+Right",
  reloadLyrics: "Alt+Shift+R",
};

function gamingPreset(): Preset {
  return {
    name: "Gaming",
    monitor: null,
    position: null,
    size: { w: 520, h: 90 },
    font: { family: "Segoe UI", sizePx: 26, weight: 600 },
    colors: { base: "#ffffffcc", fill: "#4fc3f7", textShadow: true, outline: false },
    opacity: 0.55,
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
    position: null,
    size: { w: 900, h: 260 },
    font: { family: "Segoe UI", sizePx: 44, weight: 700 },
    colors: { base: "#ffffffdd", fill: "#ffd54f", textShadow: true, outline: true },
    opacity: 1,
    background: "glass",
    backgroundColor: "#101015aa",
    contextLines: { before: 1, after: 1 },
    lineSpacing: 1.35,
    animation: "fill",
  };
}

function subtitlePreset(): Preset {
  return {
    name: "Subtitle",
    monitor: null,
    position: null,
    size: { w: 760, h: 130 },
    font: { family: "Segoe UI", sizePx: 32, weight: 600 },
    colors: { base: "#ffffffee", fill: "#8bc34a", textShadow: true, outline: false },
    opacity: 0.95,
    background: "none",
    backgroundColor: "#000000aa",
    contextLines: { before: 0, after: 0 },
    lineSpacing: 1.25,
    animation: "fill",
  };
}

export function defaultSettings(): Settings {
  return {
    activePreset: "Karaoke",
    presets: {
      Gaming: gamingPreset(),
      Karaoke: karaokePreset(),
      Subtitle: subtitlePreset(),
    },
    providerOrder: ["lrclib", "musixmatch", "netease", "applemusic"],
    providersEnabled: {
      lrclib: true,
      musixmatch: true,
      netease: true,
      applemusic: false,
      manual: true,
    },
    preferWordLevel: true,
    appleMusic: { mediaUserToken: "", developerToken: "", storefront: "us" },
    translation: {
      enabled: false,
      provider: "deepl",
      apiKey: "",
      baseUrl: "",
      model: "",
      targetLang: "en",
    },
    romanization: { ja: false, jaFurigana: false, zh: false, ko: false, ru: false },
    hotkeys: { ...DEFAULT_HOTKEYS },
    autoHide: { enabled: true, delaySec: 5 },
    globalOffsetMs: 0,
    uiTheme: "dark",
  };
}

export function activePreset(s: Settings): Preset {
  return s.presets[s.activePreset] ?? karaokePreset();
}
