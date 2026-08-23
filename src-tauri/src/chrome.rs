//! The buttons that replace the title bar we turned off. Settings is a sheet inside the main
//! window: a second window falls outside the capability scope and comes up with no IPC at all.

use tauri::{AppHandle, Manager};

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
