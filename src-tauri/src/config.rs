// Rust-side view of the persisted settings (single source of truth is the
// tauri-plugin-store file written by the frontend). Only the fields the Rust
// core needs are modelled; everything is `#[serde(default)]` so a missing or
// partial file degrades to sensible defaults.
use std::collections::HashMap;

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::lyrics::SourceId;

pub const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppleMusicCfg {
    pub media_user_token: String,
    pub developer_token: String,
    pub storefront: String,
}

impl Default for AppleMusicCfg {
    fn default() -> Self {
        Self {
            media_user_token: String::new(),
            developer_token: String::new(),
            storefront: "us".into(),
        }
    }
}

impl AppleMusicCfg {
    pub fn is_configured(&self) -> bool {
        !self.media_user_token.trim().is_empty() && !self.developer_token.trim().is_empty()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslationCfg {
    /// Show translations at all (Original vs Translated view). Gates the keyless
    /// provider translation lookup so we don't fetch when the user hides them.
    pub show: bool,
    pub enabled: bool,
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub target_lang: String,
}

impl Default for TranslationCfg {
    fn default() -> Self {
        Self {
            show: true,
            enabled: false,
            provider: "deepl".into(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            target_lang: "en".into(),
        }
    }
}

impl TranslationCfg {
    /// Target language for the keyless provider translation lookup, or None when
    /// translations are hidden or the target is unset.
    pub fn wanted_lang(&self) -> Option<String> {
        let lang = self.target_lang.trim();
        (self.show && !lang.is_empty()).then(|| lang.to_lowercase())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderSettings {
    pub provider_order: Vec<SourceId>,
    pub providers_enabled: HashMap<String, bool>,
    pub prefer_word_level: bool,
    pub apple_music: AppleMusicCfg,
    pub translation: TranslationCfg,
    pub global_offset_ms: i64,
    /// action id -> accelerator string.
    pub hotkeys: HashMap<String, String>,
}

/// Fallback accelerators, used for any action the saved settings don't mention.
///
/// Must list every `HotkeyAction`. An action missing here is never registered on
/// a fresh install — the settings file only carries what the UI has written, so
/// a gap is invisible on a developer machine whose config predates the action.
/// `hotkeys::tests::defaults_cover_every_action` fails if this falls behind.
fn default_hotkeys() -> HashMap<String, String> {
    [
        ("toggleOverlay", "Alt+Shift+L"),
        ("toggleEditMode", "Alt+Shift+E"),
        ("offsetMinus", "Alt+Shift+["),
        ("offsetPlus", "Alt+Shift+]"),
        ("driftMinus", "Alt+Shift+,"),
        ("driftPlus", "Alt+Shift+."),
        ("prevLine", "Alt+Shift+Left"),
        ("nextLine", "Alt+Shift+Right"),
        ("reloadLyrics", "Alt+Shift+R"),
        ("cycleFormPrev", "Alt+Shift+Up"),
        ("cycleFormNext", "Alt+Shift+Down"),
        ("syncMark", "Alt+Shift+S"),
        ("resetSync", "Alt+Shift+0"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[cfg(test)]
pub(crate) fn default_hotkey_ids() -> Vec<String> {
    default_hotkeys().into_keys().collect()
}

#[cfg(test)]
pub(crate) fn default_hotkey_pairs() -> Vec<(String, String)> {
    default_hotkeys().into_iter().collect()
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            provider_order: vec![
                SourceId::Lrclib,
                SourceId::Musixmatch,
                SourceId::Netease,
                SourceId::Applemusic,
            ],
            providers_enabled: HashMap::new(),
            prefer_word_level: true,
            apple_music: AppleMusicCfg::default(),
            translation: TranslationCfg::default(),
            global_offset_ms: 0,
            hotkeys: default_hotkeys(),
        }
    }
}

impl ProviderSettings {
    /// Hotkeys with defaults filled in for any missing action.
    pub fn hotkeys_or_default(&self) -> HashMap<String, String> {
        let mut map = default_hotkeys();
        for (k, v) in &self.hotkeys {
            if !v.trim().is_empty() {
                map.insert(k.clone(), v.clone());
            }
        }
        map
    }
}

impl ProviderSettings {
    /// Whether a provider is enabled. Apple Music defaults off; others on.
    pub fn is_enabled(&self, id: SourceId) -> bool {
        let key = serde_json::to_value(id)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let default = id != SourceId::Applemusic;
        self.providers_enabled.get(&key).copied().unwrap_or(default)
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> ProviderSettings {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
