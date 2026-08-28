//! The sessions themselves: one pty each, its ring of recent output, and whoever is attached.

use crate::protocol::{SessionInfo, Spawn};
use crate::modes::Modes;
use crate::ring::Ring;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// What the host tells a connection: output for a session, or that it ended.
#[derive(Debug, Clone)]
pub enum Event {
    Output { id: u32, bytes: Vec<u8> },
    Exit { id: u32, code: Option<u32> },
}

/// 1 MiB per session is a few thousand lines of a TUI redrawing itself, which is plenty to
/// put the screen back. Scrollback beyond that is what capture logs are for.
pub const RING_BYTES: usize = 1024 * 1024;

struct Session {
    info: SessionInfo,
    /// Taken (and dropped) by the waiter thread when the child exits: on Windows the reader
    /// only unblocks when the master goes away, and dropping it is also what closes the
    /// pseudoconsole.
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    ring: Ring,
    modes: Modes,
    /// The connection currently looking at this session, if any.
    attached: Option<mpsc::UnboundedSender<Event>>,
    /// The capture file, behind its own lock so the reader thread writes to it AFTER letting go
    /// of the registry: every pty reader, every request and every hook event contend for that
    /// one mutex, and a disk write was being done while holding it. Opened lazily on the first
    /// chunk; buffered, flushed when capture stops or the shell ends.
    log: Option<(String, Arc<Mutex<Option<BufWriter<File>>>>)>,
}

#[derive(Default)]
pub struct Registry {
    sessions: HashMap<u32, Session>,
    next_id: u32,
}

pub type Shared = Arc<Mutex<Registry>>;

/// Ends a process and everything it started. Windows has no process groups to signal, and
/// `TerminateProcess` on the parent orphans the children rather than taking them with it.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    match std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(s) if s.success() => {}
        // Exit code 128 is "no such process" — already gone is a success here. Anything else is
        // the anti-orphan cleanup not cleaning, and that must at least leave a trace.
        Ok(s) if s.code() == Some(128) => {}
        other => eprintln!("obpterm-host: taskkill /PID {pid} did not take: {other:?}"),
    }
}

/// One scheduling notch below the window, and — because Windows hands BELOW_NORMAL down to
/// every child a process starts — below `claude` and every agent it fans out. Ordering, not a
/// cap: an idle machine still gives Claude every cycle; a saturated one serves the terminal's
/// few milliseconds per frame first, which is what keeps the window answering clicks while
/// twenty Node processes have the CPU. Set on the shell's own pid the moment it exists, before
/// it has started anything. (Raising the window instead does not work: ABOVE_NORMAL is not
/// inherited, and WebView2 offers no way to lift its renderer.)
#[cfg(windows)]
fn lower_priority(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_SET_INFORMATION, false, pid) {
            Ok(handle) => {
                if let Err(e) = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS) {
                    eprintln!("obpterm-host: SetPriorityClass({pid}) failed: {e}");
                }
                let _ = CloseHandle(handle);
            }
            Err(e) => eprintln!("obpterm-host: OpenProcess({pid}) for priority failed: {e}"),
        }
    }
}

#[cfg(not(windows))]
fn lower_priority(_pid: u32) {}

impl Registry {
    pub fn list(&self) -> Vec<SessionInfo> {
        let mut out: Vec<SessionInfo> = self.sessions.values().map(|s| s.info.clone()).collect();
        out.sort_by_key(|s| s.id);
        out
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn any_attached(&self) -> bool {
        self.sessions.values().any(|s| s.attached.is_some())
    }

    /// Starts a shell. The reader thread pumps its output into the ring and to whoever is
    /// attached, and reports the exit when the pty closes. `hook_env` is the extra environment
    /// that lets a Claude Code hook inside the shell find its way back to this session.
    pub fn spawn(shared: &Shared, spawn: Spawn, hook_env: &[(String, String)]) -> Result<u32, String> {
        let id = {
            let mut reg = shared.lock().unwrap();
            reg.next_id += 1;
            reg.next_id
        };
        let pair = native_pty_system()
            .openpty(PtySize { rows: spawn.rows, cols: spawn.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;
        let mut cmd = CommandBuilder::new(&spawn.exe);
        cmd.args(&spawn.args);
        if let Some(cwd) = spawn.cwd.as_deref().filter(|c| !c.is_empty()) {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("OBPTERM_PANE_ID", id.to_string());
        for (k, v) in hook_env {
            cmd.env(k, v);
        }
        for (k, v) in &spawn.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn {}: {e}", spawn.exe))?;
        let pid = child.process_id();
        if spawn.below_normal {
            if let Some(pid) = pid {
                lower_priority(pid);
            }
        }
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

        {
            let mut reg = shared.lock().unwrap();
            reg.sessions.insert(
                id,
                Session {
                    info: SessionInfo {
                        id,
                        exe: spawn.exe.clone(),
                        cwd: spawn.cwd.clone(),
                        attached: false,
                        exited: None,
                        started_at: now_ms(),
                        last_output: now_ms(),
                        bell: false,
                        agent_state: None,
                        agent_detail: None,
                        claude_session_id: None,
                        pid,
                    },
                    master: Some(pair.master),
                    writer,
                    killer,
                    ring: Ring::new(RING_BYTES),
                    modes: Modes::default(),
                    attached: None,
                    log: None,
                },
            );
        }

        // The waiter owns exit detection: on Windows the pty read does NOT end when the child
        // exits — it blocks until the master is dropped, so waiting on the reader alone would
        // never notice. wait(), report, then drop the master to unblock the reader.
        let waiter_shared = Arc::clone(shared);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|st| st.exit_code());
            let mut reg = waiter_shared.lock().unwrap();
            if let Some(s) = reg.sessions.get_mut(&id) {
                s.info.exited = Some(code.unwrap_or(0));
                if let Some(tx) = &s.attached {
                    let _ = tx.send(Event::Exit { id, code });
                }
                drop(s.master.take());
            }
        });

        let shared = Arc::clone(shared);
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Everything under the registry lock is bookkeeping; the capture write
                        // is taken out of it (the handle is cloned, the lock dropped, then the
                        // disk is touched).
                        let log = {
                            let mut reg = shared.lock().unwrap();
                            let Some(s) = reg.sessions.get_mut(&id) else { break };
                            s.ring.push(&buf[..n]);
                            s.modes.track(&buf[..n]);
                            s.info.last_output = now_ms();
                            // ConPTY stalls all output until its cursor-position query is answered.
                            // An attached terminal answers it; a detached session has nobody to,
                            // and would otherwise freeze until the next attach.
                            if s.attached.is_none() && buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                                let _ = s.writer.write_all(b"\x1b[1;1R");
                                let _ = s.writer.flush();
                            }
                            // A window that is not looking still wants to know the shell asked for it.
                            if s.attached.is_none() && buf[..n].contains(&0x07) {
                                s.info.bell = true;
                            }
                            if let Some(tx) = &s.attached {
                                if tx.send(Event::Output { id, bytes: buf[..n].to_vec() }).is_err() {
                                    s.attached = None;
                                    s.info.attached = false;
                                }
                            }
                            s.log.as_ref().map(|(path, file)| (path.clone(), Arc::clone(file)))
                        };
                        if let Some((path, file)) = log {
                            let mut file = file.lock().unwrap();
                            if file.is_none() {
                                *file = File::create(path.as_str()).ok().map(|f| BufWriter::with_capacity(16 * 1024, f));
                            }
                            if let Some(f) = file.as_mut() {
                                let _ = f.write_all(&buf[..n]);
                            }
                        }
                    }
                }
            }
            // The reader ends when the waiter drops the master (or the pty errors). The waiter
            // owns exit reporting; the session stays in the map, exited, so a window that
            // reconnects can still see what it printed. What the capture buffered goes to disk.
            let log = shared.lock().unwrap().sessions.get(&id).and_then(|s| s.log.as_ref().map(|(_, f)| Arc::clone(f)));
            if let Some(file) = log {
                if let Some(f) = file.lock().unwrap().as_mut() {
                    let _ = f.flush();
                }
            }
        });
        Ok(id)
    }

    /// Hands back the replay and routes future output to `tx`. Any previous watcher is dropped:
    /// two windows looking at one shell is a feature for another year.
    pub fn attach(&mut self, id: u32, tx: mpsc::UnboundedSender<Event>, cols: u16, rows: u16) -> Result<(Vec<u8>, Option<u32>), String> {
        let s = self.sessions.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
        s.attached = Some(tx);
        s.info.attached = true;
        s.info.bell = false;
        // A full-screen program repaints on a size change; this is what turns the replay
        // into a live screen instead of a stale one.
        if let Some(master) = s.master.as_ref() {
            let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
        // Clear whatever the new terminal shows, re-assert the modes the ring no longer holds,
        // then the history. The resize above makes a full-screen program repaint after it.
        let mut replay = b"\x1b[3J\x1b[2J\x1b[H".to_vec();
        replay.extend(s.modes.reassert());
        replay.extend(s.ring.snapshot());
        Ok((replay, s.info.exited))
    }

    pub fn detach(&mut self, id: u32) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.attached = None;
            s.info.attached = false;
        }
    }

    /// Drops every watcher a closing connection held.
    pub fn detach_all_for(&mut self, tx: &mpsc::UnboundedSender<Event>) {
        for s in self.sessions.values_mut() {
            if s.attached.as_ref().is_some_and(|t| t.same_channel(tx)) {
                s.attached = None;
                s.info.attached = false;
            }
        }
    }

    pub fn write(&mut self, id: u32, bytes: &[u8]) -> Result<(), String> {
        let s = self.sessions.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
        s.writer.write_all(bytes).map_err(|e| format!("write: {e}"))
    }

    pub fn resize(&mut self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let s = self.sessions.get(&id).ok_or_else(|| format!("no session {id}"))?;
        match s.master.as_ref() {
            Some(master) => master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("resize: {e}")),
            None => Ok(()), // already exited; nothing to resize
        }
    }

    /// Ends the shell and forgets the session. An already-exited session is simply forgotten.
    pub fn kill(&mut self, id: u32) -> Result<(), String> {
        let mut s = self.sessions.remove(&id).ok_or_else(|| format!("no session {id}"))?;
        if s.info.exited.is_none() {
            #[cfg(windows)]
            if s.info.pid.is_none() {
                eprintln!("obpterm-host: session {id} has no pid — its tree cannot be killed, only the shell");
            }
            // The shell is not the only process in the pane. `claude` runs as its child, and
            // terminating the shell leaves it running with nothing attached to it — which is how
            // a laptop ends up with 35 Claude Code processes behind 17 open sessions. Take the
            // tree, then the shell (already gone by then on Windows, which is fine).
            #[cfg(windows)]
            if let Some(pid) = s.info.pid {
                kill_tree(pid);
            }
            let killed = s.killer.kill();
            #[cfg(not(windows))]
            killed.map_err(|e| format!("kill: {e}"))?;
            #[cfg(windows)]
            drop(killed); // the tree kill got there first; its "no such process" is not an error
        }
        // The waiter also drops its copy, but this session left the map before it could.
        drop(s.master.take());
        Ok(())
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }

    /// The latest hook-derived facts, kept so a window that reconnects starts truthful.
    pub fn note_agent(&mut self, pane: u32, state: &str, detail: Option<&str>, session_id: Option<&str>) {
        if let Some(s) = self.sessions.get_mut(&pane) {
            s.info.agent_state = Some(state.to_string());
            s.info.agent_detail = detail.map(str::to_string);
            if let Some(sid) = session_id {
                s.info.claude_session_id = Some(sid.to_string());
            }
        }
    }

    pub fn log_start(&mut self, id: u32, path: String) -> Result<String, String> {
        let s = self.sessions.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
        s.log = Some((path.clone(), Arc::new(Mutex::new(None))));
        Ok(path)
    }

    pub fn log_stop(&mut self, id: u32) {
        if let Some(s) = self.sessions.get_mut(&id) {
            // Dropping the last handle flushes too, but the reader thread may still hold one
            // mid-write; flush here so the file is complete the moment capture says it stopped.
            if let Some((_, file)) = s.log.take() {
                if let Some(f) = file.lock().unwrap().as_mut() {
                    let _ = f.flush();
                }
            }
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
