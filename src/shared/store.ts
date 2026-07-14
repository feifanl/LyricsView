import { load, type Store } from "@tauri-apps/plugin-store";
import { defaultSettings, type Settings } from "./settings";

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

function mergeDefaults(raw: Partial<Settings> | undefined): Settings {
  const base = defaultSettings();
  if (!raw) return base;
  // One-time migration: when the schema version changes, refresh the built-in
  // presets and active preset (keeps functional config like keys/tokens).
  const migrate = raw.schemaVersion !== base.schemaVersion;
  return {
    ...base,
    ...raw,
    schemaVersion: base.schemaVersion,
    presets: migrate ? base.presets : (raw.presets ?? base.presets),
    activePreset: migrate ? base.activePreset : (raw.activePreset ?? base.activePreset),
    providersEnabled: { ...base.providersEnabled, ...raw.providersEnabled },
    appleMusic: { ...base.appleMusic, ...raw.appleMusic },
    translation: { ...base.translation, ...raw.translation },
    romanization: { ...base.romanization, ...raw.romanization },
    hotkeys: { ...base.hotkeys, ...raw.hotkeys },
    autoHide: { ...base.autoHide, ...raw.autoHide },
  };
}
