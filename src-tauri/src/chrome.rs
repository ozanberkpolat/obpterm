//! The settings window, and the buttons that replace the title bar we turned off.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Opens settings in its own window (or focuses the one already open).
#[tauri::command]
pub fn open_settings(app: AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.set_focus().map_err(|e| e.to_string())?;
        if let Some(section) = section {
            let _ = window.emit_to("settings", "settings:section", section);
        }
        return Ok(());
    }
    let url = format!("settings.html{}", section.map(|s| format!("#{s}")).unwrap_or_default());
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url.into()))
        .title("OBPTerm Settings")
        .inner_size(1180.0, 880.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .background_color(tauri::webview::Color(10, 14, 20, 255))
        .build()
        .map_err(|e| format!("open settings: {e}"))?;
    Ok(())
}

/// minimize | maximize | close, for the buttons in our own header bar.
#[tauri::command]
pub fn window_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let window = app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?;
    let result = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            // One button, two directions — the header swaps its icon to match.
            if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() }
        }
        "close" => window.close(),
        other => return Err(format!("unknown window action {other}")),
    };
    result.map_err(|e| e.to_string())
}
