// #[tauri::command] surface. Commands are added milestone by milestone; this
// module currently exposes the window-interaction and SMTC subsets.
use tauri::{AppHandle, Manager, Runtime};

use crate::lyrics::{LyricsDoc, SourceId};
use crate::model::{SearchCandidate, SessionInfo, TrackInfo};
use crate::providers;
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

#[tauri::command]
pub async fn fetch_lyrics<R: Runtime>(
    app: AppHandle<R>,
    track: TrackInfo,
    force: bool,
) -> Option<LyricsDoc> {
    // Caching (cache-first + `force` bypass) is layered on in milestone 7.
    let _ = force;
    providers::fetch_best(&app, &track).await
}

#[tauri::command]
pub async fn search_provider<R: Runtime>(
    app: AppHandle<R>,
    provider: SourceId,
    query: String,
) -> Vec<SearchCandidate> {
    providers::search(&app, provider, &query).await
}

#[tauri::command]
pub async fn fetch_candidate<R: Runtime>(
    app: AppHandle<R>,
    candidate: SearchCandidate,
) -> Option<LyricsDoc> {
    providers::fetch_candidate(&app, &candidate).await
}
