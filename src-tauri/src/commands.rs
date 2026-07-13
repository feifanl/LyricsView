// #[tauri::command] surface. Commands are added milestone by milestone; this
// module currently exposes the window-interaction and SMTC subsets.
use tauri::{AppHandle, Manager, Runtime};

use crate::cache::Cache;
use crate::lyrics::{LyricsDoc, SourceId};
use crate::model::{CacheInfo, SearchCandidate, SessionInfo, TrackInfo, TrackMeta};
use crate::normalize::track_key;
use crate::parse::parse_lrc;
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
    let key = track_key(&track);
    let cache = Cache::new(&app);

    // Cache-first unless the caller forces a refresh (reload hotkey).
    if !force {
        if let Some(doc) = cache.load(&key).and_then(|e| e.best_doc()) {
            return Some(doc);
        }
    }

    match providers::fetch_best(&app, &track).await {
        Some(doc) => {
            cache.store_doc(&key, &doc);
            Some(doc)
        }
        // On a forced refresh with no network, fall back to whatever is cached.
        None => cache.load(&key).and_then(|e| e.best_doc()),
    }
}

#[tauri::command]
pub fn save_manual_lyrics<R: Runtime>(
    app: AppHandle<R>,
    track_key: String,
    lrc_text: String,
) -> Result<LyricsDoc, String> {
    let doc = parse_lrc(&lrc_text, SourceId::Manual, &track_key).map_err(|e| e.to_string())?;
    let cache = Cache::new(&app);
    cache.store_doc(&track_key, &doc);
    cache.set_preferred(&track_key, SourceId::Manual);
    Ok(doc)
}

#[tauri::command]
pub fn set_preferred_source<R: Runtime>(app: AppHandle<R>, track_key: String, source: SourceId) {
    Cache::new(&app).set_preferred(&track_key, source);
}

#[tauri::command]
pub fn set_track_offset<R: Runtime>(app: AppHandle<R>, track_key: String, offset_ms: i64) {
    Cache::new(&app).set_offset(&track_key, offset_ms);
}

#[tauri::command]
pub fn get_track_meta<R: Runtime>(app: AppHandle<R>, track_key: String) -> TrackMeta {
    let entry = Cache::new(&app).load(&track_key).unwrap_or_default();
    TrackMeta {
        preferred_source: entry.preferred_source,
        offset_ms: entry.offset_ms,
    }
}

#[tauri::command]
pub fn get_cache_info<R: Runtime>(app: AppHandle<R>) -> CacheInfo {
    let (entries, bytes) = Cache::new(&app).info();
    CacheInfo { entries, bytes }
}

#[tauri::command]
pub fn clear_cache<R: Runtime>(app: AppHandle<R>) {
    Cache::new(&app).clear();
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
