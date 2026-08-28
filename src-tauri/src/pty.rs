//! The window's view of the shells. Nothing here owns a pty: the session host does (see the
//! `obpterm-host` crate), and this module is its client. That is what lets the window close,
//! update and come back to shells that never stopped.
//!
//! Output reaches the webview over a Tauri `Channel<Response>` as raw bytes, exactly as before
//! the host existed; the frontend did not have to learn anything new to survive a restart.

use crate::config::Profile;
use obpterm_host::client::{Client, Delivery};
use obpterm_host::protocol::{SessionInfo, Spawn};
use obpterm_host::Advert;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

/// The live connection to the host, once there is one.
#[derive(Default)]
pub struct HostLink(pub Mutex<Option<Arc<Client>>>);

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: u32,
    code: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct HostInfo {
    pub instance: String,
    pub version: String,
    pub connected: bool,
}

fn link(state: &State<HostLink>) -> Result<Arc<Client>, String> {
    state.0.lock().unwrap().clone().ok_or_else(|| "not connected to the session host".to_string())
}

/// Connects to a running host, or starts one and connects. Called at startup and again by any
/// command that finds the link gone.
pub async fn ensure(app: &AppHandle) -> Result<Arc<Client>, String> {
    if let Some(c) = app.state::<HostLink>().0.lock().unwrap().clone() {
        if !*c.gone.borrow() {
            return Ok(c);
        }
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let advert = obpterm_host::advert_path(&dir);

    if let Some(c) = try_connect(&advert).await {
        *app.state::<HostLink>().0.lock().unwrap() = Some(Arc::clone(&c));
        return Ok(c);
    }
    // Nothing answering: a stale advert from a host that died, or a first launch.
    let _ = std::fs::remove_file(&advert);
    launch_host(&dir)?;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(c) = try_connect(&advert).await {
            *app.state::<HostLink>().0.lock().unwrap() = Some(Arc::clone(&c));
            return Ok(c);
        }
    }
    Err("the session host did not start".into())
}

async fn try_connect(advert: &PathBuf) -> Option<Arc<Client>> {
    let text = std::fs::read_to_string(advert).ok()?;
    let advert: Advert = serde_json::from_str(&text).ok()?;
    Client::connect(&advert).await.ok()
}

/// Forwards hook-derived agent updates from the host to the webview, and installs the hook
/// block into every Claude settings.json the config names. Returns which files were changed.
#[tauri::command]
pub async fn hooks_ensure(app: AppHandle, dirs: Vec<String>, no_remote_control: bool) -> Result<Vec<String>, String> {
    let client = ensure(&app).await?;
    // One watcher for the window's lifetime: agent updates become Tauri events.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    client.watch_agents(tx);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(u) = rx.recv().await {
            let _ = emitter.emit(
                "agent",
                serde_json::json!({
                    "pane": u.pane, "state": u.state, "session_id": u.session_id,
                    "detail": u.detail, "pending_id": u.pending_id, "options": u.options,
                    "tool": u.tool, "tool_input": u.tool_input,
                    "agent_id": u.agent_id, "agent_kind": u.agent_kind,
                    "agent_task": u.agent_task, "agent_event": u.agent_event, "agent_ref": u.agent_ref,
                    "agent_parent": u.agent_parent, "mode": u.mode,
                }),
            );
        }
    });

    let mut changed = Vec::new();
    // The statusLine still runs through the host binary; the hooks no longer do (see
    // install.rs). Make sure the binary is there either way, whether or not this launch was the
    // one that spawned the host.
    let exe = ensure_host_copy().unwrap_or_else(|_| host_copy_path()).display().to_string();
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    // What the running host actually bound — written by `start_hooks` before its socket ever
    // accepts a client, so this is never a race against `ensure()` above.
    let hookaddr = obpterm_host::hookaddr::load(&config_dir).ok_or("the session host has no hook address yet")?;
    for dir in dirs {
        let path = PathBuf::from(expand_vars(&dir)).join("settings.json");
        // A missing file is a fresh account; a file that EXISTS but does not parse is someone's
        // real settings half-written or hand-edited, and overwriting it with a near-empty
        // object would take their permissions and statusLine with it. config.rs's own rule:
        // a corrupt file is an error, not a silent reset.
        let mut settings: serde_json::Value = match std::fs::read_to_string(&path) {
            Err(_) => serde_json::json!({}),
            Ok(text) => match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(e) => {
                    changed.push(format!("SKIPPED {} — does not parse ({e}); fix or delete it", path.display()));
                    continue;
                }
            },
        };
        let hooks_done = obpterm_host::install::installed(&settings)
            && obpterm_host::install::current(&settings, hookaddr.port, &hookaddr.token);
        let mut wrote = false;
        if !hooks_done {
            obpterm_host::install::install(&mut settings, hookaddr.port, &hookaddr.token);
            wrote = true;
        }
        // Same pass, same file: the token meters' statusLine (never over a user's own).
        wrote |= obpterm_host::install::statusline_install(&mut settings, &exe);
        // Re-asserted on every launch, like the hooks: `/remote-control` off is per-session, so
        // an app update — which restarts every session — used to bring it back each time.
        wrote |= obpterm_host::install::remote_control_set(&mut settings, no_remote_control);
        if !wrote {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        changed.push(path.display().to_string());
    }
    Ok(changed)
}

/// Removes the hook block from the named settings files.
#[tauri::command]
pub fn hooks_remove(dirs: Vec<String>) -> Result<usize, String> {
    let mut removed = 0;
    for dir in dirs {
        let path = PathBuf::from(expand_vars(&dir)).join("settings.json");
        let Some(mut settings) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
            continue;
        };
        let had_hooks = obpterm_host::install::installed(&settings);
        if had_hooks {
            obpterm_host::install::remove(&mut settings);
        }
        if !obpterm_host::install::statusline_remove(&mut settings) && !had_hooks {
            continue;
        }
        std::fs::write(&path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

/// Whether anyone is looking at the window. The host holds a permission request for seconds when
/// someone is and for minutes when nobody is — the difference between "the prompt is right there"
/// and "he is in another room with his phone".
#[tauri::command]
pub fn window_focus(link: State<HostLink>, focused: bool) -> Result<(), String> {
    // Not an error worth surfacing: with no host connected there is nothing to tell.
    if let Ok(client) = self::link(&link) {
        client.focus(focused);
    }
    Ok(())
}

/// The rail's verdict on a held permission request.
#[tauri::command]
pub fn agent_answer(link: State<HostLink>, pending: String, allow: Option<bool>) -> Result<(), String> {
    self::link(&link)?.answer(pending, allow);
    Ok(())
}

/// The host runs from a copy outside the install folder, under its own name. Two reasons:
/// Windows cannot replace a running executable, so an installer must never meet it; and the
/// installer kills `OBPTerm.exe` by name, which a differently named copy escapes.
/// Puts this version's host binary in place and returns where it is.
///
/// Called from BOTH paths that need it, and that is the point: the hooks and the statusLine are
/// commands naming this exact file, and until now it was only ever copied on the way to
/// SPAWNING a host. Since v0.21.18 the host survives an app update — so the new window attaches
/// to the old host, never spawns, never copies, and then writes a statusLine pointing at a file
/// that does not exist. The status row inside Claude vanishes and `limits.json` stops being
/// written, which is the quota meter going stale.
pub fn ensure_host_copy() -> Result<PathBuf, String> {
    let source = host_binary().ok_or("obpterm-host is not next to the app")?;
    let copies = host_copy_dir();
    std::fs::create_dir_all(&copies).map_err(|e| format!("create {}: {e}", copies.display()))?;
    let copy = host_copy_path();
    if !copy.exists() {
        std::fs::copy(&source, &copy).map_err(|e| format!("copy host: {e}"))?;
    }
    Ok(copy)
}

fn launch_host(config_dir: &PathBuf) -> Result<(), String> {
    let copy = ensure_host_copy()?;
    let mut cmd = std::process::Command::new(&copy);
    cmd.arg(config_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // The whole point of the host is to outlive this window. A process started inside a
        // Job object dies with it when that job is set to kill on close — which is how an
        // installer, or a launcher that wraps the app, can take every shell down with the app
        // it replaced. Break out of the job so the host is nobody's child.
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| format!("start {}: {e}", copy.display()))?;
    Ok(())
}

/// Bundled as a Tauri sidecar: it lands next to OBPTerm.exe under its plain name.
fn host_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "obpterm-host.exe" } else { "obpterm-host" };
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

/// The versioned copy the host runs from — and the binary the hooks and the statusLine call,
/// so the path has to be the same one `launch_host` spawns.
pub fn host_copy_path() -> PathBuf {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    host_copy_dir().join(format!("obpterm-host-{}{ext}", env!("CARGO_PKG_VERSION")))
}

fn host_copy_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("OBPTerm").join("host")
}

/// Forwards one session's deliveries to the webview until it exits.
fn pump(app: AppHandle, id: u32, on_data: Channel<Response>, mut rx: tokio::sync::mpsc::UnboundedReceiver<Delivery>) {
    tauri::async_runtime::spawn(async move {
        while let Some(d) = rx.recv().await {
            match d {
                Delivery::Output(bytes) => {
                    if on_data.send(Response::new(bytes)).is_err() {
                        break;
                    }
                }
                Delivery::Replaying => {
                    let _ = app.emit("pty:replaying", id);
                }
                Delivery::Live => {
                    let _ = app.emit("pty:live", id);
                }
                Delivery::Exit(code) => {
                    let _ = app.emit("pty:exit", ExitPayload { id, code });
                    break;
                }
            }
        }
    });
}

#[tauri::command]
pub async fn host_info(app: AppHandle) -> HostInfo {
    match ensure(&app).await {
        Ok(c) => HostInfo { instance: c.instance.clone(), version: c.version.clone(), connected: true },
        Err(_) => HostInfo { instance: String::new(), version: String::new(), connected: false },
    }
}

#[tauri::command]
pub async fn pty_list(app: AppHandle) -> Result<Vec<SessionInfo>, String> {
    ensure(&app).await?.list().await
}

/// `below_normal` is the config's `shells_below_normal`, passed per spawn because the window
/// owns the config and the host owns the process (see `registry::lower_priority`).
#[tauri::command]
pub async fn pty_spawn(app: AppHandle, profile: Profile, cols: u16, rows: u16, below_normal: bool, on_data: Channel<Response>) -> Result<u32, String> {
    let client = ensure(&app).await?;
    let mut env = std::collections::BTreeMap::new();
    env.insert("OBPTERM".to_string(), env!("CARGO_PKG_VERSION").to_string());
    for (k, v) in &profile.env {
        env.insert(k.clone(), expand_vars(v));
    }
    let id = client
        .spawn(Spawn {
            exe: profile.exe.clone(),
            args: profile.args.clone(),
            cwd: usable_cwd(profile.cwd.as_deref().map(expand_vars)),
            env,
            cols,
            rows,
            below_normal,
        })
        .await?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    client.attach(id, cols, rows, tx).await?;
    pump(app, id, on_data, rx);
    Ok(id)
}

/// Picks up a shell the host already has — what a restart, or an update, reattaches to.
#[tauri::command]
pub async fn pty_attach(app: AppHandle, id: u32, cols: u16, rows: u16, on_data: Channel<Response>) -> Result<(), String> {
    let client = ensure(&app).await?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    client.attach(id, cols, rows, tx).await?;
    pump(app, id, on_data, rx);
    Ok(())
}

#[tauri::command]
pub fn pty_write(link: State<HostLink>, id: u32, data: String) -> Result<(), String> {
    self::link(&link)?.write(id, data.as_bytes());
    Ok(())
}

#[tauri::command]
pub fn pty_resize(link: State<HostLink>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    self::link(&link)?.resize(id, cols, rows);
    Ok(())
}

/// Stops watching a shell without ending it: what a sleeping tab does to save memory.
#[tauri::command]
pub fn pty_detach(link: State<HostLink>, id: u32) -> Result<(), String> {
    self::link(&link)?.detach(id);
    Ok(())
}

/// Ends the shell. Closing a tab means this; closing the window does not.
#[tauri::command]
pub fn pty_kill(link: State<HostLink>, id: u32) -> Result<(), String> {
    self::link(&link)?.kill(id);
    Ok(())
}

#[tauri::command]
pub async fn pty_log_start(link: State<'_, HostLink>, id: u32, dir: String, name: String, stamp: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let dir = PathBuf::from(expand_vars(&dir));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{safe}-{stamp}-{id}.log"));
    self::link(&link)?.log_start(id, path.display().to_string()).await
}

#[tauri::command]
pub fn pty_log_stop(link: State<HostLink>, id: u32) -> Result<(), String> {
    self::link(&link)?.log_stop(id);
    Ok(())
}

/// Ends the host and starts a fresh one, without closing the window. The graceful path is the
/// socket; a host that will not answer (or predates the request) is killed by the pid in its
/// own advert, because a stale host holding the shells is exactly the state this exists to
/// escape. The window reloads afterwards and restores its tabs against the new host.
#[tauri::command]
pub async fn host_restart(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let advert_path = obpterm_host::advert_path(&dir);
    let advert: Option<Advert> = std::fs::read_to_string(&advert_path).ok().and_then(|t| serde_json::from_str(&t).ok());

    if let Some(c) = app.state::<HostLink>().0.lock().unwrap().clone() {
        c.shutdown();
    }
    *app.state::<HostLink>().0.lock().unwrap() = None;

    // Give the graceful exit a moment, then make sure it is gone.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    if let Some(a) = &advert {
        if still_running(a.pid) {
            kill_pid(a.pid);
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }
    let _ = std::fs::remove_file(&advert_path);

    let client = ensure(&app).await?;
    Ok(client.version.clone())
}

#[cfg(windows)]
fn still_running(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn still_running(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
}

/// Ends every shell and the host with them. The one way out that means it.
#[tauri::command]
pub fn host_shutdown(link: State<HostLink>) -> Result<(), String> {
    self::link(&link)?.shutdown();
    Ok(())
}

/// How many capture files there are, how much they take, and how many are empty.
#[tauri::command]
pub fn capture_stats(dir: String) -> (usize, u64, usize) {
    let mut count = 0;
    let mut bytes = 0;
    let mut empty = 0;
    for entry in std::fs::read_dir(PathBuf::from(dir)).into_iter().flatten().flatten() {
        if entry.path().extension().is_none_or(|e| e != "log") {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        count += 1;
        bytes += len;
        if len == 0 {
            empty += 1;
        }
    }
    (count, bytes, empty)
}

/// Applies the capture retention rule: always drops empty files, then anything older than
/// `keep_days`, then the oldest files until the folder fits in `max_mb`. Either limit at 0
/// means "no limit". A file a live pane is still writing to is never touched.
#[tauri::command]
pub async fn prune_captures(app: AppHandle, dir: String, keep_days: u32, max_mb: u32) -> (usize, u64) {
    // Live captures are whatever the host is writing right now; ask it rather than guess.
    let live: Vec<PathBuf> = Vec::new();
    let _ = &app;
    let mut files: Vec<(i64, u64, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(PathBuf::from(dir)).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "log") || live.contains(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.push((modified, meta.len(), path));
    }
    let doomed = plan_prune(files, now_secs(), keep_days, max_mb);
    let mut deleted = 0;
    let mut freed = 0;
    for (size, path) in doomed {
        // A file that is open for writing by the host cannot be removed on Windows anyway;
        // a failed delete is skipped, not reported.
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
            freed += size;
        }
    }
    (deleted, freed)
}

/// Which captures the rule says to drop, oldest first: empties, then anything past its age,
/// then as many of the oldest survivors as it takes to fit the size cap. Pure, so it is
/// testable without touching a disk.
fn plan_prune(mut files: Vec<(i64, u64, PathBuf)>, now: i64, keep_days: u32, max_mb: u32) -> Vec<(u64, PathBuf)> {
    files.sort_by_key(|f| f.0);
    // `None` is the honest "no age limit": a sentinel of 0 conflates being disabled with a
    // cutoff that happens to be non-positive, and then the rule quietly stops applying.
    let cutoff = (keep_days > 0).then(|| now - (keep_days as i64) * 86_400);
    let mut doomed = Vec::new();
    let mut kept: Vec<(u64, PathBuf)> = Vec::new();

    for (modified, size, path) in files {
        if size == 0 || cutoff.is_some_and(|c| modified < c) {
            doomed.push((size, path));
        } else {
            kept.push((size, path));
        }
    }

    let cap = (max_mb as u64) * 1024 * 1024;
    if cap > 0 {
        let mut total: u64 = kept.iter().map(|(size, _)| size).sum();
        for (size, path) in kept {
            if total <= cap {
                break;
            }
            total -= size;
            doomed.push((size, path));
        }
    }
    doomed
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Expands `%NAME%` (and a leading `~`) in a config value — CreateProcess does not, so an
/// account whose CLAUDE_CONFIG_DIR reads `%USERPROFILE%\.claude-work` would otherwise create a
/// folder with a literal percent sign in its name.
pub fn expand_vars(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = if let Some(tail) = value.strip_prefix('~') {
        out.push_str(&home_dir().unwrap_or_default());
        tail
    } else {
        value
    };
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    // An unset variable stays literal rather than silently becoming "".
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()
}

/// Creates the configured directory if it is missing; falls back to the home directory rather
/// than letting the shell start wherever the process happens to be.
fn usable_cwd(cwd: Option<String>) -> Option<String> {
    let Some(cwd) = cwd else { return home_dir() };
    let path = std::path::Path::new(&cwd);
    if path.is_dir() {
        return Some(cwd);
    }
    match std::fs::create_dir_all(path) {
        Ok(()) => Some(cwd),
        Err(e) => {
            eprintln!("OBPTerm: cannot use {cwd} ({e}), starting in the home directory instead");
            home_dir()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_vars, plan_prune};
    use std::path::PathBuf;

    const DAY: i64 = 86_400;
    const MB: u64 = 1024 * 1024;

    fn file(age_days: i64, mb: u64, name: &str) -> (i64, u64, PathBuf) {
        (1_000_000 - age_days * DAY, mb * MB, PathBuf::from(name))
    }

    #[test]
    fn config_values_expand_the_way_people_type_them() {
        std::env::set_var("OBPTERM_TEST_HOME", "X:\\users\\me");
        assert_eq!(expand_vars("%OBPTERM_TEST_HOME%\\.claude"), "X:\\users\\me\\.claude");
        assert_eq!(expand_vars("plain\\path"), "plain\\path");
        assert_eq!(expand_vars("%NOT_SET_ANYWHERE%\\x"), "%NOT_SET_ANYWHERE%\\x", "unset stays literal");
        assert_eq!(expand_vars("50% done"), "50% done", "a lone percent is not a variable");
    }

    #[test]
    fn empties_and_old_files_go_first() {
        let files = vec![
            (1_000_000, 0, PathBuf::from("empty.log")),
            file(40, 1, "ancient.log"),
            file(2, 1, "fresh.log"),
        ];
        let doomed: Vec<String> = plan_prune(files, 1_000_000, 30, 0)
            .into_iter()
            .map(|(_, p)| p.display().to_string())
            .collect();
        assert_eq!(doomed, vec!["ancient.log", "empty.log"], "oldest first, and the empty one always");
    }

    #[test]
    fn the_size_cap_takes_the_oldest_survivors_and_stops() {
        let files = (0..4).map(|i| file(4 - i, 100, &format!("f{i}.log"))).collect();
        let doomed = plan_prune(files, 1_000_000, 0, 250);
        assert_eq!(doomed.len(), 2);
        assert_eq!(doomed[0].1, PathBuf::from("f0.log"));
        assert_eq!(doomed[1].1, PathBuf::from("f1.log"));
    }

    #[test]
    fn the_age_limit_applies_at_a_real_epoch_too() {
        let now = 1_787_500_000;
        let files = vec![
            (now - 40 * DAY, 1 * MB, PathBuf::from("ancient.log")),
            (now - 2 * DAY, 1 * MB, PathBuf::from("fresh.log")),
        ];
        let doomed = plan_prune(files, now, 30, 0);
        assert_eq!(doomed.len(), 1);
        assert_eq!(doomed[0].1, PathBuf::from("ancient.log"));
    }

    #[test]
    fn zero_means_no_limit() {
        let files = vec![file(9999, 5000, "huge-and-ancient.log")];
        assert!(plan_prune(files, 1_000_000, 0, 0).is_empty(), "both limits off keeps everything");
    }
}
