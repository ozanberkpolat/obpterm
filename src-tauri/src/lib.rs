mod extras;
mod claude;
mod logins;
mod chrome;
mod config;
mod metrics;
mod pty;
mod update;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::HostLink::default())
        .manage(claude::UsageCache::default())
        .manage(metrics::Metrics::default())
        .invoke_handler(tauri::generate_handler![
            pty::host_info,
            pty::host_shutdown,
            pty::host_restart,
            pty::host_restart,
            pty::pty_list,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_detach,
            pty::hooks_ensure,
            pty::hooks_remove,
            pty::agent_answer,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_log_start,
            pty::pty_log_stop,
            pty::capture_stats,
            pty::prune_captures,
            config::config_load,
            config::config_save,
            config::config_path_string,
            config::log_dir,
            config::config_reset,
            config::config_export,
            config::reveal,
            chrome::window_action,
            chrome::attention,
            chrome::taskbar_badge,
            chrome::keep_awake,
            update::ntfy_publish,
            metrics::rss_for,
            claude::session_context,
            extras::git_shortstat,
            extras::allow_rule,
            extras::save_clip_image,
            extras::worktree_status,
            extras::worktree_add,
            extras::worktree_remove,
            config::session_load,
            config::session_save,
            claude::claude_account,
            claude::claude_account_names,
            claude::claude_usage,
            claude::claude_limits,
            claude::session_title,
            logins::logins_list,
            logins::logins_save,
            logins::logins_switch,
            logins::logins_forget,
            metrics::host_metrics,
            update::app_version,
            update::update_check,
            update::update_install,
        ])
        .setup(|app| {
            let main = app.get_webview_window("main").expect("main window");
            disable_browser_accelerators(&main);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                config::mark_clean_exit(window.app_handle());
                // Deliberately no kill here: closing the window is a detach. The shells belong
                // to the session host and are still there when the window comes back.
                *window.state::<pty::HostLink>().0.lock().unwrap() = None;
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OBPTerm");
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
            eprintln!("OBPTerm: could not disable WebView2 accelerator keys: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("OBPTerm: with_webview failed: {e}");
    }
}

#[cfg(not(windows))]
fn disable_browser_accelerators(_window: &tauri::WebviewWindow) {}
