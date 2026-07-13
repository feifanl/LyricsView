// Lyricify-OSS Rust core: window/tray setup, plugin registration and the
// #[tauri::command] surface. Providers and cache modules are added in later
// milestones.
mod commands;
pub mod lyrics;
mod model;
mod normalize;
pub mod parse;
mod smtc;
mod tray;
mod window;

use smtc::SmtcState;
use window::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .manage(SmtcState::default())
        .setup(|app| {
            let handle = app.handle();
            tray::build_tray(handle)?;

            // Overlay starts in locked (click-through) mode.
            if let Some(overlay) = window::overlay_window(handle) {
                let _ = overlay.set_ignore_cursor_events(true);
            }

            // Start the SMTC now-playing watcher on its own thread.
            smtc::start(handle.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_click_through,
            commands::set_edit_mode,
            commands::list_smtc_sessions,
            commands::set_pinned_session,
            commands::current_track_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lyricify-OSS");
}
