//! `config.json` in the app config dir (`%APPDATA%\tr.com.obp.obpterm\` on Windows).
//! Missing fields fall back to defaults, unknown fields are ignored, so adding a field later
//! needs no migration. A corrupt file is an error, not a silent reset.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

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
    /// Extra environment for this shell — how an account preset reaches the process.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Start capturing this shell's output to a log the moment it opens.
    #[serde(default)]
    pub capture: bool,
}

/// A command you keep retyping. The palette lists them; picking one types it into the pane.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub text: String,
    /// Press Enter for you. Off means it is left on the prompt to edit.
    #[serde(default)]
    pub send: bool,
}

/// An account is an environment preset: `CLAUDE_CONFIG_DIR` for a Claude Code login,
/// `AZURE_CONFIG_DIR` / `AWS_PROFILE` / `KUBECONFIG` for a cloud CLI. obpterm never touches
/// credentials itself — it only launches shells pointed at the right directory.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Read for the login identity and the token meters in the status bar.
    #[serde(default)]
    pub claude_dir: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// An SSH target. Becomes a profile whose exe is `ssh.exe` when a tab opens on it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
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
    /// Rail groups remember whether they are folded away.
    #[serde(default)]
    pub collapsed: bool,
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
    /// Rail width in pixels, set by dragging its edge.
    pub rail_width: u32,
    /// "bar" | "block" | "underline" — passed straight to xterm.
    pub cursor_style: String,
    pub cursor_blink: bool,
    /// Right-click copies a selection and pastes when there is none.
    pub right_click_paste: bool,
    /// Finishing a drag copies the selection, the way the /ssh/ terminal behaves.
    pub copy_on_select: bool,
    /// The UI accent. The terminal's own cursor colour lives in `theme`.
    pub accent: String,
    /// Fade panes that are not focused.
    pub dim_inactive_panes: bool,
    /// Where Ctrl+Shift+L writes; `None` = the app's own logs folder.
    pub capture_dir: Option<String>,
    /// Delete captures older than this many days. 0 keeps them forever.
    pub capture_keep_days: u32,
    /// Keep the capture folder under this many megabytes, oldest first. 0 is no cap.
    pub capture_max_mb: u32,
    /// Ask GitHub for a newer release once, a few seconds after launch.
    pub update_check_on_launch: bool,
    /// Minutes a tab can go unvisited before its terminal is torn down to save memory; the
    /// shell keeps running in the host and the tab wakes on click. 0 = never.
    pub sleep_after_minutes: u32,
    /// Minutes a finished, unfocused Claude session sits before /exit frees its ~335 MB.
    /// The tab stays; clicking it runs `claude --resume`. 0 = never.
    pub eco_after_minutes: u32,
    /// Desktop notification when an unfocused pane rings or asks for something.
    pub notify_bell: bool,
    /// Desktop notification when a busy pane goes quiet — a build or an agent finishing.
    pub notify_silence: bool,
    /// How long a pane must be quiet, after being busy, to count as finished.
    pub silence_seconds: u32,
    /// Where shells start when nothing more specific applies.
    pub default_cwd: Option<String>,
    /// `owner/repo` the "check for updates" button asks GitHub about.
    pub update_repo: Option<String>,
    /// Needed only while that repo is private: a token with read access to its releases.
    pub github_token: Option<String>,
    pub projects: Vec<Project>,
    pub accounts: Vec<Account>,
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    /// Account applied to new shells when nothing else says otherwise.
    pub default_account: Option<String>,
    /// A file your Claude Code statusLine writes the rate_limits payload to.
    pub limits_file: Option<String>,
    /// An endpoint on your own machine serving the same numbers (the homelab /ssh/ terminal
    /// already does: http://host:3007/api/status). Nothing is contacted unless this is set.
    pub limits_url: Option<String>,
    /// Shortcut overrides: action id -> chord ("Ctrl+Shift+KeyT"); the frontend owns the ids.
    pub keybindings: BTreeMap<String, String>,
    /// Full ntfy publish URL including the topic (e.g. https://ntfy.sh/mytopic, or a
    /// self-hosted one). `None` = no pushes; the app contacts nothing that is not configured.
    pub ntfy_url: Option<String>,
    /// Bearer token for that topic, when it needs one.
    pub ntfy_token: Option<String>,
    /// Hold the machine out of sleep while any agent is working.
    pub keep_awake: bool,
    /// Every config save is mirrored to `<this folder>/obpterm-config.json` (tokens stripped).
    /// Point it at a OneDrive / Google Drive folder and the cloud client does the transport.
    pub backup_dir: Option<String>,
    /// Your own budget for the status-bar meters, in tokens. `None` shows plain totals.
    pub quota_5h_tokens: Option<u64>,
    pub quota_7d_tokens: Option<u64>,
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
            rail_width: 232,
            cursor_style: "bar".into(),
            cursor_blink: true,
            right_click_paste: true,
            copy_on_select: true,
            accent: "#ff8a1e".into(),
            dim_inactive_panes: true,
            capture_dir: None,
            capture_keep_days: 30,
            capture_max_mb: 512,
            update_check_on_launch: true,
            sleep_after_minutes: 10,
            eco_after_minutes: 30,
            notify_bell: true,
            notify_silence: false,
            silence_seconds: 20,
            default_cwd: default_cwd(),
            update_repo: Some("ozanberkpolat/obpterm".into()),
            github_token: None,
            projects: Vec::new(),
            accounts: default_accounts(),
            hosts: Vec::new(),
            snippets: Vec::new(),
            default_account: None,
            limits_file: None,
            limits_url: None,
            quota_5h_tokens: None,
            quota_7d_tokens: None,
            restore_session: true,
            session: None,
            theme: sentinel_theme(),
            keybindings: BTreeMap::new(),
            backup_dir: None,
            ntfy_url: None,
            ntfy_token: None,
            keep_awake: true,
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
        env: Default::default(),
        capture: false,
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
        env: Default::default(),
        capture: false,
    }]
}

/// A working directory of one's own, created on first use rather than dropping into
/// `C:\Windows\System32` or the user's profile root.
fn default_cwd() -> Option<String> {
    if cfg!(windows) {
        Some("C:\\OBP".into())
    } else {
        std::env::var("HOME").ok()
    }
}

/// One account out of the box: whatever `~/.claude` already holds, so the status bar has
/// something true to show before anything is configured.
fn default_accounts() -> Vec<Account> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    if home.is_empty() {
        return Vec::new();
    }
    let dir = PathBuf::from(&home).join(".claude");
    vec![Account {
        id: "default".into(),
        name: "Default".into(),
        env: Default::default(), // no CLAUDE_CONFIG_DIR: this *is* the default one
        claude_dir: Some(dir.display().to_string()),
        color: None,
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
        // Without this, a selected cell keeps its own colour: brightBlack on the orange wash
        // measures 2.07:1 and git hashes disappear as you select them.
        ("selectionForeground", "#eaf0f7"),
        // #141a24 was 1.11:1 on the background — box drawing and table rules were invisible.
        ("black", "#313c4f"),
        ("red", "#ff6b73"),
        ("green", "#2fd6a3"),
        ("yellow", "#ffb454"),
        ("blue", "#4c8dff"),
        ("magenta", "#b48cff"),
        ("cyan", "#22d3ee"),
        ("white", "#c9d3e0"),
        // The most-printed dim colour in a shell (git hashes, ls metadata, comments): 4.53:1.
        ("brightBlack", "#6c7c8f"),
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

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("config.json"))
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("session.json"))
}

/// The app was called `winterm` until 0.3.0; carry that config over on first run.
fn migrate_from_winterm(app: &AppHandle, target: &Path) {
    let Some(old) = target
        .parent()
        .and_then(|d| d.parent())
        .map(|p| p.join("tr.com.obp.winterm").join("config.json"))
    else {
        return;
    };
    if !old.exists() {
        return;
    }
    match std::fs::copy(&old, target) {
        Ok(_) => eprintln!("OBPTerm: carried over {} from the old winterm config", old.display()),
        Err(e) => eprintln!("OBPTerm: could not copy {}: {e}", old.display()),
    }
    let _ = app; // kept for symmetry with the other helpers
}

#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<Config, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        migrate_from_winterm(&app, &path);
    }
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
    write(&config_path(&app)?, &config)?;
    // The other window is showing the same config; tell it to reload rather than letting the
    // two drift apart.
    let _ = app.emit("config:changed", ());
    // The mirror rides every save; its failure must not read as "config not saved".
    if let Err(e) = mirror(&config) {
        return Err(format!("Saved — but the backup mirror failed: {e}"));
    }
    Ok(())
}

/// A copy for another machine: the whole config minus tokens. Credentials never ride along —
/// a new laptop signs into Claude once and the hooks/statusLine reinstall themselves.
fn portable(config: &Config) -> Config {
    let mut copy = config.clone();
    copy.github_token = None;
    copy.ntfy_token = None;
    copy.session = None; // machine-bound: pty ids from this host
    copy
}

fn mirror(config: &Config) -> Result<(), String> {
    let Some(dir) = config.backup_dir.as_deref().filter(|d| !d.is_empty()) else {
        return Ok(());
    };
    let dir = PathBuf::from(crate::pty::expand_vars(dir));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    write(&dir.join("obpterm-config.json"), &portable(config))
}

/// Writes a portable copy into the Downloads folder and returns its path.
#[tauri::command]
pub fn config_export(app: AppHandle, config: Config) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let stamp = chrono_free_date();
    let path = dir.join(format!("obpterm-config-{stamp}.json"));
    write(&path, &portable(&config))?;
    Ok(path.display().to_string())
}

/// YYYY-MM-DD without pulling in chrono: days since epoch, civil-calendar arithmetic.
fn chrono_free_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let z = secs as i64 / 86400 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Puts the defaults back, keeping the open tabs.
#[tauri::command]
pub fn config_reset(app: AppHandle) -> Result<Config, String> {
    let cfg = Config::default();
    write(&config_path(&app)?, &cfg)?;
    let _ = app.emit("config:changed", ());
    Ok(cfg)
}

/// Opens a folder in the OS file manager: "config" | "logs".
#[tauri::command]
pub fn reveal(app: AppHandle, what: String) -> Result<String, String> {
    let dir = match what.as_str() {
        "logs" => PathBuf::from(log_dir(app)?),
        _ => config_dir(&app)?,
    };
    let opener = if cfg!(windows) { "explorer" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(&dir)
        // explorer.exe returns a non-zero exit code even when it worked, so the status is
        // deliberately not checked.
        .spawn()
        .map_err(|e| format!("open {}: {e}", dir.display()))?;
    Ok(dir.display().to_string())
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

fn write(path: &Path, cfg: &Config) -> Result<(), String> {
    write_atomic(path, &serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?)
}

/// Write to a sibling temp file and rename over the target: a crash mid-write can then only
/// lose the newest state, never leave a half-written file where the old one was.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

/// The open tabs. Kept out of config.json because it is written constantly and config.json is
/// a file the user edits by hand.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Session {
    /// False while the app is running; set true when the window closes normally. A session that
    /// loads with `clean_exit: false` is one the app never got to close — a crash, or a kill.
    pub clean_exit: bool,
    pub saved_at: i64,
    /// Shape owned by the frontend (SavedTab[] from src/app.ts).
    pub tabs: serde_json::Value,
    /// Index of the tab that was in front — restoring to the last tab in the array is not
    /// where you were when the app died.
    #[serde(default)]
    pub active: usize,
    /// The session host the pty ids in `tabs` belong to. Ids only mean something against the
    /// host that minted them; after a reboot they are numbers from a dead process.
    #[serde(default)]
    pub host: Option<String>,
    /// Set when the exit was an installer restart, so the next launch says "updated", not "crashed".
    pub updated_to: Option<String>,
}

#[tauri::command]
pub fn session_load(app: AppHandle) -> Result<Session, String> {
    let path = session_path(&app)?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        // A truncated session is not worth failing the launch over.
        return Ok(serde_json::from_str(&text).unwrap_or_default());
    }
    // Before 0.3.0 the tabs lived in config.json.
    let legacy = config_load(app)?.session.unwrap_or(serde_json::Value::Null);
    Ok(Session { clean_exit: true, saved_at: 0, tabs: legacy, active: 0, host: None, updated_to: None })
}

#[tauri::command]
pub fn session_save(app: AppHandle, tabs: serde_json::Value, active: usize, host: Option<String>) -> Result<(), String> {
    let session = Session { clean_exit: false, saved_at: now_ms(), tabs, active, host, updated_to: None };
    write_atomic(&session_path(&app)?, &serde_json::to_string(&session).map_err(|e| e.to_string())?)
}

/// The installer is about to kill us on purpose: record that, so the relaunch reports an update
/// rather than a crash.
pub fn mark_updating(app: &AppHandle, version: &str) {
    edit_session(app, |s| {
        s.clean_exit = true;
        s.updated_to = Some(version.to_string());
    });
}

/// Called when the window closes normally, so the next launch knows this was not a crash.
pub fn mark_clean_exit(app: &AppHandle) {
    edit_session(app, |s| s.clean_exit = true);
}

fn edit_session(app: &AppHandle, change: impl FnOnce(&mut Session)) {
    let Ok(path) = session_path(app) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut session) = serde_json::from_str::<Session>(&text) else { return };
    change(&mut session);
    if let Ok(text) = serde_json::to_string(&session) {
        let _ = write_atomic(&path, &text);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn portable_strips_the_secrets_and_the_session() {
        let mut cfg = Config::default();
        cfg.github_token = Some("ghp_x".into());
        cfg.ntfy_token = Some("tk_x".into());
        cfg.session = Some(serde_json::json!({"tabs": []}));
        let p = portable(&cfg);
        assert!(p.github_token.is_none() && p.ntfy_token.is_none() && p.session.is_none());
        assert_eq!(p.profiles.len(), cfg.profiles.len(), "everything else survives");
    }

    #[test]
    fn export_stamp_is_a_date() {
        let d = chrono_free_date();
        assert_eq!(d.len(), 10, "{d}");
        assert!(d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-', "{d}");
        assert!(d.starts_with("20"), "{d}");
    }

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
    fn a_session_file_survives_a_round_trip_and_a_truncated_one_does_not_panic() {
        let session = Session {
            clean_exit: false,
            saved_at: 1_787_463_711_904,
            tabs: serde_json::json!([{ "root": { "kind": "leaf", "profile": "pwsh" } }]),
            active: 2,
            host: Some("abc123".into()),
            updated_to: Some("0.4.1".into()),
        };
        let text = serde_json::to_string(&session).unwrap();
        assert_eq!(serde_json::from_str::<Session>(&text).unwrap(), session);
        assert_eq!(serde_json::from_str::<Session>("{\"clean_exit\":true}").unwrap().tabs, serde_json::Value::Null);
        assert!(serde_json::from_str::<Session>("{\"clean_exi").is_err(), "the caller falls back to default");
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
            collapsed: true,
        });
        // The frontend owns the session shape: whatever it wrote must come back byte-identical.
        cfg.session = Some(serde_json::json!([{"root": {"kind": "split", "dir": "row", "ratio": 0.5}}]));
        let back: Config = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back, cfg);
    }
}
