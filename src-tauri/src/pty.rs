//! One ConPTY (Windows) / pty (elsewhere) per tab, owned here, streamed to the webview.
//!
//! Output goes over a Tauri `Channel<Response>`: `Response::new(bytes)` is the raw-bytes path,
//! the frontend receives an `ArrayBuffer`. (A plain `Vec<u8>` would be JSON-encoded as an
//! array of numbers - ~4x the bytes.)

use crate::config::Profile;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
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
    let cwd = profile.cwd.clone().or_else(home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("WINTERM", env!("CARGO_PKG_VERSION"));

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", profile.exe))?;
    drop(pair.slave); // the master must be the only remaining handle, or EOF never arrives

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions
        .0
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });

    // ponytail: chunked reads, no backpressure; add pause/resume if huge output lags the UI.
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // ConPTY reports a closed console as an error, not 0
                Ok(n) => {
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

pub fn kill_all(sessions: &Sessions) {
    for s in sessions.0.lock().unwrap().values_mut() {
        let _ = s.child.kill();
    }
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()
}
