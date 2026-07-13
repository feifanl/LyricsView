// Overlay/settings window helpers shared by the tray, hotkeys and commands.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// App-wide runtime state (not persisted; settings live in the store plugin).
#[derive(Default)]
pub struct AppState {
    pub edit_mode: Mutex<bool>,
}

#[derive(Clone, Serialize)]
struct EditModePayload {
    enabled: bool,
}

pub fn overlay_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("overlay")
}

pub fn settings_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("settings")
}

pub fn toggle_overlay<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = overlay_window(app) {
        let visible = w.is_visible().unwrap_or(false);
        let _ = if visible { w.hide() } else { w.show() };
    }
}

pub fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = settings_window(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Locked mode = click-through (ignore cursor events). Edit mode = interactive.
pub fn set_edit_mode<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.edit_mode.lock().unwrap() = enabled;
    }
    if let Some(w) = overlay_window(app) {
        // Click-through and drag/resize are mutually exclusive.
        let _ = w.set_ignore_cursor_events(!enabled);
        if enabled {
            let _ = w.set_focus();
        }
    }
    let _ = app.emit_to("overlay", "overlay://edit-mode", EditModePayload { enabled });
}

pub fn toggle_edit_mode<R: Runtime>(app: &AppHandle<R>) {
    let current = app
        .try_state::<AppState>()
        .map(|s| *s.edit_mode.lock().unwrap())
        .unwrap_or(false);
    set_edit_mode(app, !current);
}
