//! `config.json` in the app config dir (`%APPDATA%\tr.com.obp.winterm\` on Windows).
//! Missing fields fall back to defaults, unknown fields are ignored, so adding a field later
//! needs no migration. A corrupt file is an error, not a silent reset.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory; `None` = the user's home.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// A named group of tabs with a colour, a home directory and its own saved layout.
/// Only the frontend gives these meaning; they live here so config.json is hand-editable.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Any CSS colour; replaces the orange accent for this project's tabs.
    pub color: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub default_profile: Option<String>,
    /// Tabs saved with "Save project layout" - shape owned by the frontend.
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Config {
    pub default_profile: String,
    pub profiles: Vec<Profile>,
    pub font_family: String,
    pub font_size: u16,
    pub scrollback: u32,
    pub rail_collapsed: bool,
    pub projects: Vec<Project>,
    /// Reopen the tabs that were open at quit.
    pub restore_session: bool,
    /// The tabs open at last quit; shape owned by the frontend (see src/layout.ts).
    pub session: Option<serde_json::Value>,
    /// Passed straight through as xterm.js `ITheme` (background, foreground, cursor, black … brightWhite).
    pub theme: BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            default_profile: default_profiles()[0].id.clone(),
            profiles: default_profiles(),
            font_family: "JetBrains Mono, Cascadia Mono, Consolas, monospace".into(),
            font_size: 14,
            scrollback: 10_000,
            rail_collapsed: false,
            projects: Vec::new(),
            restore_session: true,
            session: None,
            theme: sentinel_theme(),
        }
    }
}

#[cfg(windows)]
fn default_profiles() -> Vec<Profile> {
    let p = |id: &str, name: &str, exe: &str, args: &[&str]| Profile {
        id: id.into(),
        name: name.into(),
        exe: exe.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: None,
    };
    vec![
        p("pwsh", "PowerShell 7", "pwsh.exe", &["-NoLogo"]),
        p("powershell", "Windows PowerShell", "powershell.exe", &["-NoLogo"]),
        p("cmd", "Command Prompt", "cmd.exe", &[]),
    ]
}

#[cfg(not(windows))]
fn default_profiles() -> Vec<Profile> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    vec![Profile {
        id: "shell".into(),
        name: shell.rsplit('/').next().unwrap_or("shell").to_string(),
        exe: shell,
        args: vec![],
        cwd: None,
    }]
}

/// The Sentinel console palette (iot-stack DESIGN.md): near-black slate, one orange accent.
fn sentinel_theme() -> BTreeMap<String, String> {
    [
        ("background", "#0a0e14"),
        ("foreground", "#eaf0f7"),
        ("cursor", "#ff8a1e"),
        ("cursorAccent", "#0a0e14"),
        ("selectionBackground", "rgba(255,138,30,0.28)"),
        ("black", "#141a24"),
        ("red", "#ff6b73"),
        ("green", "#2fd6a3"),
        ("yellow", "#ffb454"),
        ("blue", "#4c8dff"),
        ("magenta", "#b48cff"),
        ("cyan", "#22d3ee"),
        ("white", "#c9d3e0"),
        ("brightBlack", "#5b6878"),
        ("brightRed", "#ff7a85"),
        ("brightGreen", "#5ee8bd"),
        ("brightYellow", "#ffc97a"),
        ("brightBlue", "#7aaaff"),
        ("brightMagenta", "#cbb0ff"),
        ("brightCyan", "#67e3f5"),
        ("brightWhite", "#eaf0f7"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<Config, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        let cfg = Config::default();
        write(&path, &cfg)?;
        return Ok(cfg);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not valid config: {e}", path.display()))
}

#[tauri::command]
pub fn config_save(app: AppHandle, config: Config) -> Result<(), String> {
    write(&config_path(&app)?, &config)
}

/// Where `pty_log_start` puts capture files, unless the caller passes its own directory.
#[tauri::command]
pub fn log_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn config_path_string(app: AppHandle) -> Result<String, String> {
    Ok(config_path(&app)?.display().to_string())
}

fn write(path: &PathBuf, cfg: &Config) -> Result<(), String> {
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_forward_compat() {
        let cfg = Config::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert_eq!(serde_json::from_str::<Config>(&json).unwrap(), cfg);
        // An old file missing fields, and a newer file with unknown ones, both load.
        let partial: Config = serde_json::from_str(r#"{"font_size": 11, "future_field": 1}"#).unwrap();
        assert_eq!(partial.font_size, 11);
        assert_eq!(partial.profiles, cfg.profiles);
        assert!(cfg.profiles.iter().any(|p| p.id == cfg.default_profile));
    }

    #[test]
    fn projects_and_opaque_session_survive_a_round_trip() {
        let mut cfg = Config::default();
        cfg.projects.push(Project {
            id: "d724".into(),
            name: "D724".into(),
            color: "#4c8dff".into(),
            cwd: Some("C:\\work".into()),
            default_profile: Some("pwsh".into()),
            layout: Some(serde_json::json!([{"kind": "leaf", "profile": "pwsh"}])),
        });
        // The frontend owns the session shape: whatever it wrote must come back byte-identical.
        cfg.session = Some(serde_json::json!([{"root": {"kind": "split", "dir": "row", "ratio": 0.5}}]));
        let back: Config = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back, cfg);
    }
}
