//! One ConPTY (Windows) / pty (elsewhere) per tab, owned here, streamed to the webview.
//!
//! Output goes over a Tauri `Channel<Response>`: `Response::new(bytes)` is the raw-bytes path,
//! the frontend receives an `ArrayBuffer`. (A plain `Vec<u8>` would be JSON-encoded as an
//! array of numbers - ~4x the bytes.)

use crate::config::Profile;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// A capture that has a path but may not have opened its file yet.
struct Capture {
    path: PathBuf,
    file: Option<File>,
}

impl Capture {
    fn write(&mut self, bytes: &[u8]) {
        if self.file.is_none() {
            self.file = File::create(&self.path).ok();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(bytes);
        }
    }
}
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Shared with the reader thread: `Some` while this session is being captured. The file is
    /// only created on the first byte — a shell that prints nothing should not leave a file.
    log: Arc<Mutex<Option<Capture>>>,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<u32, Session>>);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: u32,
    code: Option<u32>,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    sessions: State<Sessions>,
    profile: Profile,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&profile.exe);
    cmd.args(&profile.args);
    if let Some(cwd) = usable_cwd(profile.cwd.as_deref().map(expand_vars)) {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("WINTERM", env!("CARGO_PKG_VERSION"));
    for (k, v) in &profile.env {
        cmd.env(k, expand_vars(v));
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", profile.exe))?;
    drop(pair.slave); // the master must be the only remaining handle, or EOF never arrives

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let log: Arc<Mutex<Option<Capture>>> = Arc::new(Mutex::new(None));
    let log_writer = log.clone();
    sessions
        .0
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child, log });

    // ponytail: chunked reads, no backpressure; add pause/resume if huge output lags the UI.
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // ConPTY reports a closed console as an error, not 0
                Ok(n) => {
                    if let Some(capture) = log_writer.lock().unwrap().as_mut() {
                        // Raw stream, escapes and all - that is what a terminal log is.
                        capture.write(&buf[..n]);
                    }
                    if on_data.send(Response::new(buf[..n].to_vec())).is_err() {
                        break; // webview gone
                    }
                }
            }
        }
        let code = app
            .state::<Sessions>()
            .0
            .lock()
            .unwrap()
            .remove(&id)
            .and_then(|mut s| s.child.wait().ok())
            .map(|status| status.exit_code());
        let _ = app.emit("pty:exit", ExitPayload { id, code });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(sessions: State<Sessions>, id: u32, data: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
    s.writer.write_all(data.as_bytes()).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
pub fn pty_resize(sessions: State<Sessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions.0.lock().unwrap();
    let s = map.get(&id).ok_or_else(|| format!("no session {id}"))?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize: {e}"))
}

/// Kills the child; the reader thread then sees EOF, drops the session and emits `pty:exit`.
#[tauri::command]
pub fn pty_kill(sessions: State<Sessions>, id: u32) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    match map.get_mut(&id) {
        Some(s) => s.child.kill().map_err(|e| format!("kill: {e}")),
        None => Ok(()), // already exited
    }
}

/// Starts teeing this session's output to `<dir>/<name>-<stamp>.log`, and returns the path.
#[tauri::command]
pub fn pty_log_start(
    sessions: State<Sessions>,
    id: u32,
    dir: String,
    name: String,
    stamp: String,
) -> Result<String, String> {
    let map = sessions.0.lock().unwrap();
    let s = map.get(&id).ok_or_else(|| format!("no session {id}"))?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let dir = PathBuf::from(expand_vars(&dir));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // The id is in the name because two panes on the same host share a title, and the stamp
    // is only second-resolution: without it they would open the same file and interleave.
    let path = dir.join(format!("{safe}-{stamp}-{id}.log"));
    *s.log.lock().unwrap() = Some(Capture { path: path.clone(), file: None });
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn pty_log_stop(sessions: State<Sessions>, id: u32) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get(&id) {
        *s.log.lock().unwrap() = None; // dropping the File flushes it
    }
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
///
/// Returns (files deleted, bytes freed).
#[tauri::command]
pub fn prune_captures(sessions: State<Sessions>, dir: String, keep_days: u32, max_mb: u32) -> (usize, u64) {
    let live: Vec<PathBuf> = sessions
        .0
        .lock()
        .unwrap()
        .values()
        .filter_map(|s| s.log.lock().unwrap().as_ref().map(|c| c.path.clone()))
        .collect();

    // (modified epoch secs, size, path), oldest first.
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
    let cutoff = if keep_days == 0 { 0 } else { now - (keep_days as i64) * 86_400 };
    let mut doomed = Vec::new();
    let mut kept: Vec<(u64, PathBuf)> = Vec::new();

    for (modified, size, path) in files {
        if size == 0 || (cutoff > 0 && modified < cutoff) {
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

pub fn kill_all(sessions: &Sessions) {
    for s in sessions.0.lock().unwrap().values_mut() {
        let _ = s.child.kill();
    }
}

/// Expands `%NAME%` (and a leading `~`) in a config value — CreateProcess does not, so an
/// account whose CLAUDE_CONFIG_DIR reads `%USERPROFILE%\.claude-work` would otherwise create a
/// folder with a literal percent sign in its name.
fn expand_vars(value: &str) -> String {
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

    #[test]
    fn config_values_expand_the_way_people_type_them() {
        std::env::set_var("OBPTERM_TEST_HOME", "X:\\users\\me");
        assert_eq!(expand_vars("%OBPTERM_TEST_HOME%\\.claude"), "X:\\users\\me\\.claude");
        assert_eq!(expand_vars("plain\\path"), "plain\\path");
        assert_eq!(expand_vars("%NOT_SET_ANYWHERE%\\x"), "%NOT_SET_ANYWHERE%\\x", "unset stays literal");
        assert_eq!(expand_vars("50% done"), "50% done", "a lone percent is not a variable");
    }


    const DAY: i64 = 86_400;
    const MB: u64 = 1024 * 1024;

    fn file(age_days: i64, mb: u64, name: &str) -> (i64, u64, PathBuf) {
        (1_000_000 - age_days * DAY, mb * MB, PathBuf::from(name))
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
        // 4 x 100 MB, all recent, cap 250 MB: the two oldest go, the rest stay.
        let files = (0..4).map(|i| file(4 - i, 100, &format!("f{i}.log"))).collect();
        let doomed = plan_prune(files, 1_000_000, 0, 250);
        assert_eq!(doomed.len(), 2);
        assert_eq!(doomed[0].1, PathBuf::from("f0.log"));
        assert_eq!(doomed[1].1, PathBuf::from("f1.log"));
    }

    #[test]
    fn zero_means_no_limit() {
        let files = vec![file(9999, 5000, "huge-and-ancient.log")];
        assert!(plan_prune(files, 1_000_000, 0, 0).is_empty(), "both limits off keeps everything");
    }
}
