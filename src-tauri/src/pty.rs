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
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Shared with the reader thread: `Some` while this session is being captured to a file.
    log: Arc<Mutex<Option<File>>>,
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
    let log: Arc<Mutex<Option<File>>> = Arc::new(Mutex::new(None));
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
                    if let Some(f) = log_writer.lock().unwrap().as_mut() {
                        // Raw stream, escapes and all - that is what a terminal log is.
                        let _ = f.write_all(&buf[..n]);
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
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{safe}-{stamp}.log"));
    let file = File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    *s.log.lock().unwrap() = Some(file);
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn pty_log_stop(sessions: State<Sessions>, id: u32) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get(&id) {
        *s.log.lock().unwrap() = None; // dropping the File flushes it
    }
    Ok(())
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
    use super::expand_vars;

    #[test]
    fn config_values_expand_the_way_people_type_them() {
        std::env::set_var("OBPTERM_TEST_HOME", "X:\\users\\me");
        assert_eq!(expand_vars("%OBPTERM_TEST_HOME%\\.claude"), "X:\\users\\me\\.claude");
        assert_eq!(expand_vars("plain\\path"), "plain\\path");
        assert_eq!(expand_vars("%NOT_SET_ANYWHERE%\\x"), "%NOT_SET_ANYWHERE%\\x", "unset stays literal");
        assert_eq!(expand_vars("50% done"), "50% done", "a lone percent is not a variable");
    }
}
