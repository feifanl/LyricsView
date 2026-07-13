// #[tauri::command] surface. Commands are added milestone by milestone; this
// module currently exposes the window-interaction subset.
use tauri::{AppHandle, Runtime};

use crate::window::set_edit_mode as apply_edit_mode;

#[tauri::command]
pub fn set_click_through<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    // Locked (click-through) is the inverse of edit mode.
    apply_edit_mode(&app, !enabled);
}

#[tauri::command]
pub fn set_edit_mode<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    apply_edit_mode(&app, enabled);
}
