// System tray icon and menu: Show/Hide overlay, Edit mode, Settings, Quit.
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Runtime,
};

use crate::window::{open_settings, toggle_edit_mode, toggle_overlay};

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show_hide", "Show / Hide overlay", true, None::<&str>)?;
    let edit = MenuItem::with_id(app, "edit_mode", "Edit mode", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &edit, &settings, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon present");

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("LyricsView")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_hide" => toggle_overlay(app),
            "edit_mode" => toggle_edit_mode(app),
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
