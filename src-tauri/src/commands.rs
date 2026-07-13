// #[tauri::command] surface. Commands are added milestone by milestone; this
// module currently exposes the window-interaction and SMTC subsets.
use tauri::{AppHandle, Manager, Runtime};

use crate::model::SessionInfo;
use crate::smtc::{self, SmtcState};
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

#[tauri::command]
pub fn list_smtc_sessions() -> Result<Vec<SessionInfo>, String> {
    smtc::list_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_pinned_session<R: Runtime>(app: AppHandle<R>, app_id: Option<String>) {
    if let Some(state) = app.try_state::<SmtcState>() {
        *state.pinned_app_id.lock().unwrap() = app_id;
    }
}

#[tauri::command]
pub fn current_track_key<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    app.try_state::<SmtcState>()
        .and_then(|s| s.current_track.lock().unwrap().clone())
        .map(|t| crate::normalize::track_key(&t))
}
