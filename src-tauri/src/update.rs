//! "Check for updates" without an update server: the frontend asks the GitHub releases API
//! (with the token from config.json when the repo is private), and hands the installer bytes
//! back here to be written and launched. Rust does no networking.

use std::io::Write;
use tauri::AppHandle;

/// The version this binary was built as — what the check compares against.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Writes the downloaded installer to the temp dir and starts it **silently, with a restart**.
///
/// Windows cannot replace a running executable, so there is no true in-place update: the NSIS
/// installer's `/S` kills this process without a prompt and `/R` starts the new build once it is
/// in place. The session file was already written, so the new process reopens every tab.
#[tauri::command]
pub fn run_installer(app: AppHandle, name: String, version: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() < 100_000 {
        return Err(format!("{name} is only {} bytes — refusing to run it", bytes.len()));
    }
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '-' })
        .collect();
    let path = std::env::temp_dir().join(safe);
    let mut file = std::fs::File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    file.write_all(&bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    drop(file);

    crate::config::mark_updating(&app, &version);
    std::process::Command::new(&path)
        .args(["/S", "/R"])
        .spawn()
        .map_err(|e| format!("start {}: {e}", path.display()))?;
    let handle = app.clone();
    // Give the installer a moment to come up before this process disappears from under it.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        handle.exit(0);
    });
    Ok(path.display().to_string())
}
