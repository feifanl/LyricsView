// Global shortcuts. Registered on the Rust side (more reliable while the
// overlay is click-through / unfocused). Window actions run here directly;
// lyric-related actions are forwarded to the overlay via an event, since the
// sync clock and current line live there.
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::config;
use crate::window::{toggle_edit_mode, toggle_overlay};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    ToggleOverlay,
    ToggleEditMode,
    OffsetMinus,
    OffsetPlus,
    DriftMinus,
    DriftPlus,
    PrevLine,
    NextLine,
    ReloadLyrics,
    CycleFormPrev,
    CycleFormNext,
}

impl HotkeyAction {
    fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "toggleOverlay" => Self::ToggleOverlay,
            "toggleEditMode" => Self::ToggleEditMode,
            "offsetMinus" => Self::OffsetMinus,
            "offsetPlus" => Self::OffsetPlus,
            "driftMinus" => Self::DriftMinus,
            "driftPlus" => Self::DriftPlus,
            "prevLine" => Self::PrevLine,
            "nextLine" => Self::NextLine,
            "reloadLyrics" => Self::ReloadLyrics,
            "cycleFormPrev" => Self::CycleFormPrev,
            "cycleFormNext" => Self::CycleFormNext,
            _ => return None,
        })
    }
}

#[derive(Serialize, Clone)]
struct HotkeyPayload {
    action: HotkeyAction,
}

/// Registered shortcut -> action lookup, rebuilt on (re)register.
#[derive(Default)]
pub struct HotkeyMap(pub Mutex<HashMap<Shortcut, HotkeyAction>>);

/// Handler installed on the plugin builder; dispatches on key-press.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let action = app
        .try_state::<HotkeyMap>()
        .and_then(|m| m.0.lock().unwrap().get(shortcut).copied());
    if let Some(action) = action {
        perform(app, action);
    }
}

fn perform<R: Runtime>(app: &AppHandle<R>, action: HotkeyAction) {
    match action {
        HotkeyAction::ToggleOverlay => toggle_overlay(app),
        HotkeyAction::ToggleEditMode => toggle_edit_mode(app),
        // Lyric-relative actions are handled by the overlay.
        other => {
            let _ = app.emit_to("overlay", "overlay://hotkey", HotkeyPayload { action: other });
        }
    }
}

/// (Re)register all configured shortcuts from the persisted settings.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let cfg = config::load(app);
    let mut map: HashMap<Shortcut, HotkeyAction> = HashMap::new();
    for (id, accel) in cfg.hotkeys_or_default() {
        let Some(action) = HotkeyAction::from_id(&id) else {
            continue;
        };
        let Ok(shortcut) = Shortcut::from_str(&accel) else {
            eprintln!("[hotkeys] invalid accelerator: {accel}");
            continue;
        };
        if gs.register(shortcut).is_ok() {
            map.insert(shortcut, action);
        } else {
            eprintln!("[hotkeys] failed to register: {accel}");
        }
    }

    if let Some(state) = app.try_state::<HotkeyMap>() {
        *state.0.lock().unwrap() = map;
    }
}
