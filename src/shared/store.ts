import { load, type Store } from "@tauri-apps/plugin-store";
import { defaultSettings, type LyricForm, type LyricLinesCfg, type Settings } from "./settings";

const LYRIC_FORMS: LyricForm[] = ["romaji", "original", "translation"];

/** Merge saved lyric-line config over defaults, repairing the order array so it
 *  always contains exactly the three forms once each (a corrupt/partial saved
 *  order can't drop or duplicate a form). */
function mergeLyricLines(
  base: LyricLinesCfg,
  raw: Partial<LyricLinesCfg> | undefined,
): LyricLinesCfg {
  if (!raw) return { order: [...base.order], enabled: { ...base.enabled }, layout: base.layout };
  const seen = new Set<LyricForm>();
  const order: LyricForm[] = [];
  for (const f of raw.order ?? []) {
    if (LYRIC_FORMS.includes(f) && !seen.has(f)) {
      seen.add(f);
      order.push(f);
    }
  }
  for (const f of LYRIC_FORMS) if (!seen.has(f)) order.push(f); // append any missing
  return {
    order,
    enabled: { ...base.enabled, ...raw.enabled },
    layout: raw.layout ?? base.layout,
  };
}

const STORE_FILE = "settings.json";
const KEY = "settings";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: false, defaults: {} });
  return storePromise;
}

/** Load persisted settings, merged over defaults so new fields are filled in. */
export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const raw = await store.get<Partial<Settings>>(KEY);
  return mergeDefaults(raw);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  await store.set(KEY, settings);
  await store.save();
}

/** Fill any preset fields added since the file was written, without discarding
 *  user edits. Built-in presets keep their template as the fallback; unknown
 *  (user-created) presets fall back to the default Glass Bar shape. */
function mergePresets(
  base: Settings["presets"],
  raw: Settings["presets"] | undefined,
): Settings["presets"] {
  if (!raw) return base;
  const fallback = base["Glass Bar"] ?? Object.values(base)[0]!;
  const out: Settings["presets"] = { ...base };
  for (const [name, p] of Object.entries(raw)) {
    const template = base[name] ?? fallback;
    out[name] = {
      ...template,
      ...p,
      font: { ...template.font, ...p.font },
      colors: { ...template.colors, ...p.colors },
      contextLines: { ...template.contextLines, ...p.contextLines },
      size: { ...template.size, ...p.size },
    };
  }
  return out;
}

function mergeDefaults(raw: Partial<Settings> | undefined): Settings {
  const base = defaultSettings();
  if (!raw) return base;
  // A schema bump only fills in newly added fields — it must never discard the
  // user's presets, colors, keys or layout, or settings would appear to reset
  // ("not persisting") after every update.
  const migrate = raw.schemaVersion !== base.schemaVersion;
  const presets = mergePresets(base.presets, raw.presets);
  const activePreset =
    raw.activePreset && presets[raw.activePreset] ? raw.activePreset : base.activePreset;
  return {
    ...base,
    ...raw,
    schemaVersion: base.schemaVersion,
    presets,
    activePreset,
    providersEnabled: { ...base.providersEnabled, ...raw.providersEnabled },
    appleMusic: { ...base.appleMusic, ...raw.appleMusic },
    // On migration, adopt the new default for `show` (translate by default)
    // while preserving functional config like provider/key/target language.
    translation: migrate
      ? { ...base.translation, ...raw.translation, show: base.translation.show }
      : { ...base.translation, ...raw.translation },
    romanization: { ...base.romanization, ...raw.romanization },
    lyricLines: mergeLyricLines(base.lyricLines, raw.lyricLines),
    hotkeys: { ...base.hotkeys, ...raw.hotkeys },
    autoHide: { ...base.autoHide, ...raw.autoHide },
  };
}
