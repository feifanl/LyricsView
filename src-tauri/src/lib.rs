// Lyricify-OSS Rust core: window/tray setup, plugin registration and the
// #[tauri::command] surface. Providers and cache modules are added in later
// milestones.
mod cache;
mod commands;
mod config;
mod hotkeys;
mod http;
pub mod lyrics;
mod matching;
mod model;
mod normalize;
pub mod parse;
mod providers;
mod smtc;
mod translate;
mod tray;
mod window;

use hotkeys::HotkeyMap;
use smtc::SmtcState;
use window::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkeys::on_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        .manage(AppState::default())
        .manage(SmtcState::default())
        .manage(HotkeyMap::default())
        .setup(|app| {
            let handle = app.handle();
            tray::build_tray(handle)?;

            // Overlay starts in locked (click-through) mode.
            if let Some(overlay) = window::overlay_window(handle) {
                let _ = overlay.set_ignore_cursor_events(true);
            }

            // Register global shortcuts from persisted settings.
            hotkeys::apply(handle);

            // Start the SMTC now-playing watcher on its own thread.
            smtc::start(handle.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_click_through,
            commands::set_edit_mode,
            commands::toggle_overlay,
            commands::open_settings,
            commands::media_control,
            commands::list_smtc_sessions,
            commands::set_pinned_session,
            commands::current_track_key,
            commands::current_track,
            commands::export_lrc,
            commands::fetch_lyrics,
            commands::search_provider,
            commands::fetch_candidate,
            commands::save_manual_lyrics,
            commands::set_preferred_source,
            commands::set_track_offset,
            commands::set_track_stretch,
            commands::get_track_meta,
            commands::get_cache_info,
            commands::clear_cache,
            commands::apply_hotkeys,
            commands::apply_candidate,
            commands::translate_lines,
            commands::share_line_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lyricify-OSS");
}
