// Lyricify-OSS Rust core: window/tray setup, plugin registration and the
// #[tauri::command] surface. SMTC, providers and cache modules are added in
// later milestones.
mod commands;
mod tray;
mod window;

use window::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle();
            tray::build_tray(handle)?;

            // Overlay starts in locked (click-through) mode.
            if let Some(overlay) = window::overlay_window(handle) {
                let _ = overlay.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_click_through,
            commands::set_edit_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lyricify-OSS");
}
