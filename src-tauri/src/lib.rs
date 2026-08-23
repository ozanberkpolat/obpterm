mod claude;
mod config;
mod pty;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::Sessions::default())
        .manage(claude::UsageCache::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_log_start,
            pty::pty_log_stop,
            config::config_load,
            config::config_save,
            config::config_path_string,
            config::log_dir,
            claude::claude_account,
            claude::claude_account_names,
            claude::claude_usage,
        ])
        .setup(|app| {
            let main = app.get_webview_window("main").expect("main window");
            disable_browser_accelerators(&main);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                pty::kill_all(&window.state::<pty::Sessions>());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running winterm");
}

/// F5 / Ctrl+R / Ctrl+F / Ctrl+P / F12 … belong to the shell, not to WebView2. Without this the
/// webview reloads on F5 and every session dies. Not exposed in tauri.conf.json, so it goes
/// through the raw WebView2 settings. The frontend also `preventDefault`s the same keys.
#[cfg(windows)]
fn disable_browser_accelerators(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        let apply = || -> windows::core::Result<()> {
            let core = pw.controller().CoreWebView2()?;
            let settings: ICoreWebView2Settings3 = core.Settings()?.cast()?;
            settings.SetAreBrowserAcceleratorKeysEnabled(false)
        };
        if let Err(e) = apply() {
            eprintln!("winterm: could not disable WebView2 accelerator keys: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("winterm: with_webview failed: {e}");
    }
}

#[cfg(not(windows))]
fn disable_browser_accelerators(_window: &tauri::WebviewWindow) {}
