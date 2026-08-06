// #[tauri::command] surface. Commands are added milestone by milestone; this
// module currently exposes the window-interaction and SMTC subsets.
use tauri::{AppHandle, Emitter, Manager, Runtime};
use windows::Win32::Foundation::{HWND, RECT};

use crate::appbar::{AppBarState, Edge};
use crate::cache::Cache;
use crate::lyrics::{LyricsDoc, SourceId};
use crate::model::{CacheInfo, SearchCandidate, SessionInfo, TrackInfo, TrackMeta};
use crate::normalize::track_key;
use crate::parse::parse_lrc;
use crate::providers;
use crate::smtc::{self, SmtcState};
use crate::window::set_edit_mode as apply_edit_mode;

const EVT_RELOAD: &str = "overlay://reload-lyrics";

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
pub fn toggle_overlay<R: Runtime>(app: AppHandle<R>) {
    crate::window::toggle_overlay(&app);
}

#[tauri::command]
pub fn open_settings<R: Runtime>(app: AppHandle<R>) {
    crate::window::open_settings(&app);
}

#[tauri::command]
pub fn media_control<R: Runtime>(app: AppHandle<R>, action: String) -> Result<bool, String> {
    smtc::control(&app, &action).map_err(|e| e.to_string())
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
pub fn current_track<R: Runtime>(app: AppHandle<R>) -> Option<TrackInfo> {
    app.try_state::<SmtcState>()
        .and_then(|s| s.current_track.lock().unwrap().clone())
}

/// Make the watcher re-announce the playback status on its next poll.
///
/// Playback-state events are deduped: the status is emitted once and then only
/// when it changes. The watcher emits the initial status during app setup, before
/// the overlay's webview has attached its listener, so an overlay that starts
/// while a song is already playing never hears that the song is playing — and its
/// clock, which begins paused, stays frozen. Clearing the dedupe makes the next
/// poll (≤500 ms) emit again.
#[tauri::command]
pub fn resync_playback_state<R: Runtime>(app: AppHandle<R>) {
    if let Some(state) = app.try_state::<SmtcState>() {
        state.clear_playback_dedupe();
    }
}

/// Reserve (or release) a strip of desktop work area for the overlay.
///
/// `edge` is "top", "bottom", or None to release. The monitor rect and thickness
/// are physical pixels — the shell works in those, and the caller already knows
/// which monitor the preset targets.
///
/// Returns the rect the shell granted, which is not always the one asked for: it
/// slides the strip clear of the taskbar and any other appbar.
#[tauri::command]
pub fn set_reserved_bar<R: Runtime>(
    app: AppHandle<R>,
    edge: Option<String>,
    mon_left: i32,
    mon_top: i32,
    mon_right: i32,
    mon_bottom: i32,
    thickness: i32,
) -> Result<Option<(i32, i32, i32, i32)>, String> {
    let state = app
        .try_state::<AppBarState>()
        .ok_or("appbar state missing")?;
    let win = crate::window::overlay_window(&app).ok_or("overlay window missing")?;
    let hwnd = HWND(win.hwnd().map_err(|e| e.to_string())?.0 as _);

    let Some(edge) = edge.as_deref().and_then(Edge::parse) else {
        state.release(hwnd);
        return Ok(None);
    };
    if thickness <= 0 {
        state.release(hwnd);
        return Ok(None);
    }

    let mon = RECT {
        left: mon_left,
        top: mon_top,
        right: mon_right,
        bottom: mon_bottom,
    };
    let rc = state
        .reserve(hwnd, edge, mon, thickness)
        .ok_or("the shell refused the appbar registration")?;
    Ok(Some((rc.left, rc.top, rc.right, rc.bottom)))
}

/// Export a cached track's lyrics as an `.lrc` file via a save dialog.
#[tauri::command]
pub fn export_lrc<R: Runtime>(app: AppHandle<R>, track_key: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let want_lang = crate::config::load(&app)
        .translation
        .wanted_lang()
        .map(|l| crate::lyrics::base_lang(&l));
    let doc = Cache::new(&app)
        .load(&track_key)
        .and_then(|e| e.best_doc(want_lang.as_deref()))
        .ok_or_else(|| "no cached lyrics for this track".to_string())?;
    let lrc = crate::parse::serialize_lrc(&doc);

    let path = app
        .dialog()
        .file()
        .add_filter("LRC lyrics", &["lrc"])
        .set_file_name("lyrics.lrc")
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(false); // user cancelled
    };
    let path = path
        .into_path()
        .map_err(|e| e.to_string())?;
    std::fs::write(path, lrc).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn fetch_lyrics<R: Runtime>(
    app: AppHandle<R>,
    track: TrackInfo,
    force: bool,
) -> Option<LyricsDoc> {
    let key = track_key(&track);
    let cache = Cache::new(&app);
    // Read now, not inside the branches: the cache must be picked over with the
    // same criteria the network race would use, or a cache hit silently returns
    // a worse doc than a fetch would have.
    let cfg = crate::config::load(&app);
    let want_lang = cfg.translation.wanted_lang().map(|l| crate::lyrics::base_lang(&l));
    let fingerprint = providers::fetch_fingerprint(&cfg);

    // Cache-first unless the caller forces a refresh (reload hotkey), or the
    // entry predates the current provider config — a hit written under other
    // settings would pin the track to them forever.
    if !force {
        if let Some(entry) = cache.load(&key) {
            if entry.fetch_fingerprint == fingerprint {
                if let Some(doc) = entry.best_doc(want_lang.as_deref()) {
                    return Some(doc);
                }
            }
        }
    }

    let fetched = providers::fetch_all(&app, &track).await;
    if !fetched.is_empty() {
        cache.store_docs(&key, &fetched, Some(&fingerprint));
    }
    // Pick across everything the track has ever had, not only what this fetch
    // returned. A provider that times out on this run must not cost us a
    // translation already on disk — which is what made a refresh able to come
    // back with less than the cache already held.
    //
    // Falls through to the cache when the fetch found nothing at all, so no
    // network means a stale line rather than a blank overlay.
    cache.load(&key).and_then(|e| e.best_doc(want_lang.as_deref()))
}

#[tauri::command]
pub fn save_manual_lyrics<R: Runtime>(
    app: AppHandle<R>,
    track_key: String,
    lrc_text: String,
) -> Result<LyricsDoc, String> {
    let doc = parse_lrc(&lrc_text, SourceId::Manual, &track_key).map_err(|e| e.to_string())?;
    let cache = Cache::new(&app);
    cache.store_doc(&track_key, &doc, None);
    cache.set_preferred(&track_key, SourceId::Manual);
    let _ = app.emit(EVT_RELOAD, ());
    Ok(doc)
}

#[tauri::command]
pub fn set_preferred_source<R: Runtime>(app: AppHandle<R>, track_key: String, source: SourceId) {
    Cache::new(&app).set_preferred(&track_key, source);
    let _ = app.emit(EVT_RELOAD, ());
}

/// Fetch a chosen search candidate, re-key it to the given track and make it the
/// preferred source for that track.
#[tauri::command]
pub async fn apply_candidate<R: Runtime>(
    app: AppHandle<R>,
    track_key: String,
    candidate: SearchCandidate,
) -> Option<LyricsDoc> {
    let fetched = providers::fetch_candidate(&app, &candidate).await?;
    let doc = LyricsDoc {
        track_key: track_key.clone(),
        ..fetched
    };
    let cache = Cache::new(&app);
    cache.store_doc(&track_key, &doc, None);
    cache.set_preferred(&track_key, doc.source);
    let _ = app.emit(EVT_RELOAD, ());
    Some(doc)
}

#[tauri::command]
pub fn set_track_offset<R: Runtime>(app: AppHandle<R>, track_key: String, offset_ms: i64) {
    Cache::new(&app).set_offset(&track_key, offset_ms);
}

#[tauri::command]
pub fn set_track_stretch<R: Runtime>(app: AppHandle<R>, track_key: String, stretch_ppm: i64) {
    Cache::new(&app).set_stretch(&track_key, stretch_ppm);
}

#[tauri::command]
pub fn get_track_meta<R: Runtime>(app: AppHandle<R>, track_key: String) -> TrackMeta {
    let entry = Cache::new(&app).load(&track_key).unwrap_or_default();
    TrackMeta {
        preferred_source: entry.preferred_source,
        offset_ms: entry.offset_ms,
        stretch_ppm: entry.stretch_ppm,
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
pub fn apply_hotkeys<R: Runtime>(app: AppHandle<R>) {
    crate::hotkeys::apply(&app);
}

/// Copy a rendered PNG lyric card to the clipboard and offer a save dialog.
#[tauri::command]
pub fn share_line_image<R: Runtime>(app: AppHandle<R>, png: Vec<u8>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use tauri_plugin_dialog::DialogExt;

    let image = tauri::image::Image::from_bytes(&png).map_err(|e| e.to_string())?;
    app.clipboard()
        .write_image(&image)
        .map_err(|e| e.to_string())?;

    if let Some(path) = app
        .dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name("lyric-card.png")
        .blocking_save_file()
    {
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, &png).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Translate the current track's lines in one batched request, cached per track.
/// Returns the input unchanged if translation is disabled or fails.
#[tauri::command]
pub async fn translate_lines<R: Runtime>(app: AppHandle<R>, lines: Vec<String>) -> Vec<String> {
    let cfg = crate::config::load(&app).translation;
    if !cfg.enabled || cfg.api_key.trim().is_empty() || lines.is_empty() {
        return lines;
    }
    let key = app
        .try_state::<SmtcState>()
        .and_then(|s| s.current_track.lock().unwrap().clone())
        .map(|t| track_key(&t));
    let cache = Cache::new(&app);

    if let Some(key) = &key {
        if let Some(cached) = cache.cached_translation(key, &cfg.target_lang) {
            if cached.len() == lines.len() {
                return cached;
            }
        }
    }

    match crate::translate::translate(&cfg, &lines).await {
        Some(out) if out.len() == lines.len() => {
            if let Some(key) = &key {
                cache.set_translation(key, &cfg.target_lang, out.clone());
            }
            out
        }
        _ => lines,
    }
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
