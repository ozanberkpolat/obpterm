//! The host's side of the socket: accept connections, check the token, serve requests, and
//! exit on its own once nothing is running and nobody is looking.

use crate::hooks::HookHub;
use crate::protocol::{self, Reply, Request, KIND_INPUT, KIND_JSON, KIND_OUTPUT};
use crate::registry::{Event, Registry, Shared};
use crate::Advert;
use interprocess::local_socket::tokio::prelude::*;
use interprocess::local_socket::{GenericNamespaced, ListenerOptions};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::mpsc;

pub struct Host {
    pub advert: Advert,
    pub registry: Shared,
    pub hooks: Arc<HookHub>,
    /// OBPTERM_HOOK_ENV and friends, injected into every spawned shell.
    hook_env: std::sync::Mutex<Vec<(String, String)>>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

/// How long with no sessions AND no client before the host leaves on its own. Generous on
/// purpose: an installer replacing the app can easily take longer than a few seconds, and a
/// host that gave up in that window would take the shells it was holding with it.
pub const IDLE_EXIT: Duration = Duration::from_secs(300);

impl Host {
    /// `hook_token` is the http hook's own secret — separate from `token`, the local socket's —
    /// and is passed in rather than minted here so the caller can reuse whatever `hookaddr`
    /// persisted from a previous run instead of rotating it on every restart.
    pub fn new(socket: String, token: String, hook_token: String, version: &str) -> Self {
        let (shutdown, _) = tokio::sync::watch::channel(false);
        Self {
            advert: Advert {
                socket,
                token,
                instance: crate::random_hex(8),
                pid: std::process::id(),
                version: version.to_string(),
            },
            registry: Arc::new(std::sync::Mutex::new(Registry::default())),
            hooks: HookHub::new(hook_token),
            hook_env: std::sync::Mutex::new(Vec::new()),
            shutdown,
        }
    }

    /// Starts the hook listener — on `preferred_port` when the caller has one (from `hookaddr`,
    /// what a previous run persisted) — and writes two things sessions read to reach it:
    /// `hookaddr.json`, which `hooks_ensure` reads to build the http hook's literal URL and
    /// token, and the bash-sourceable env file a v2-or-earlier `command` hook still reads at
    /// invocation time. Sessions carry the ENV FILE's path in their environment, not the port
    /// it names: that indirection is what let a v2 hook survive a host restart with no
    /// persistence at all — v3 needs `hookaddr.json` instead because an http hook's URL has no
    /// such indirection (see `hookaddr`'s module doc).
    pub async fn start_hooks(&self, config_dir: &std::path::Path, preferred_port: Option<u16>) -> std::io::Result<()> {
        let port = Arc::clone(&self.hooks).listen(preferred_port).await?;
        crate::hookaddr::save(config_dir, &crate::hookaddr::HookAddr { port, token: self.hooks.token.clone() });
        let env_file = config_dir.join("hook-endpoint.env");
        std::fs::write(
            &env_file,
            format!("OBPTERM_HOOK_PORT={port}
OBPTERM_HOOK_TOKEN={}
", self.hooks.token),
        )?;
        *self.hook_env.lock().unwrap() = vec![("OBPTERM_HOOK_ENV".into(), env_file.display().to_string())];
        // Track states even while no window is connected, so `list` is truthful on reconnect.
        let registry = Arc::clone(&self.registry);
        let mut events = self.hooks.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(e) => registry.lock().unwrap().note_agent(e.pane, &e.state, e.detail.as_deref(), e.session_id.as_deref()),
                    // Falling behind the 256-slot buffer is a burst, not the end: treating it as
                    // one silently froze every session's agent state for the life of the host,
                    // and the next window to reconnect adopted the stale record as truth.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Ok(())
    }

    /// Serves until `Shutdown` arrives or the idle rule fires. Returns the reason.
    pub async fn serve(self: Arc<Self>) -> std::io::Result<&'static str> {
        let name = self.advert.socket.clone().to_ns_name::<GenericNamespaced>()?;
        let listener = ListenerOptions::new().name(name).create_tokio()?;
        let mut shutdown_rx = self.shutdown.subscribe();
        let mut idle_since: Option<tokio::time::Instant> = Some(tokio::time::Instant::now());
        let mut tick = tokio::time::interval(Duration::from_secs(2));

        loop {
            tokio::select! {
                conn = listener.accept() => {
                    let conn = conn?;
                    let host = Arc::clone(&self);
                    tokio::spawn(async move {
                        if let Err(e) = host.connection(conn).await {
                            eprintln!("obpterm-host: connection ended: {e}");
                        }
                    });
                }
                _ = shutdown_rx.changed() => {
                    self.registry.lock().unwrap().kill_all();
                    return Ok("shutdown");
                }
                _ = tick.tick() => {
                    let reg = self.registry.lock().unwrap();
                    let idle = reg.is_empty() && !reg.any_attached();
                    drop(reg);
                    match (idle, idle_since) {
                        (true, None) => idle_since = Some(tokio::time::Instant::now()),
                        (true, Some(t)) if t.elapsed() >= IDLE_EXIT => return Ok("idle"),
                        (false, _) => idle_since = None,
                        _ => {}
                    }
                }
            }
        }
    }

    async fn connection(&self, conn: interprocess::local_socket::tokio::Stream) -> std::io::Result<()> {
        let (rx_half, tx_half) = conn.split();
        let mut reader = BufReader::new(rx_half);
        let mut writer = BufWriter::new(tx_half);

        // First frame must be the token; anything else and we hang up without a word.
        let Some((KIND_JSON, body)) = protocol::read_frame(&mut reader).await? else { return Ok(()) };
        match serde_json::from_slice::<Request>(&body) {
            Ok(Request::Hello { token }) if token == self.advert.token => {}
            _ => return Ok(()),
        }
        protocol::write_json(&mut writer, &Reply::Hello { instance: self.advert.instance.clone(), version: self.advert.version.clone() }).await?;

        // Output for attached sessions arrives on this channel from the reader threads.
        let (tx, mut events) = mpsc::unbounded_channel::<Event>();
        let mut agent_events = self.hooks.subscribe();
        // Two writers (request replies and streamed output) share the socket through one task.
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
        let writer_task = tokio::spawn(async move {
            while let Some((kind, payload)) = out_rx.recv().await {
                if protocol::write_frame(&mut writer, kind, &payload).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        let send_json = |out: &mpsc::UnboundedSender<(u8, Vec<u8>)>, reply: &Reply| {
            let _ = out.send((KIND_JSON, serde_json::to_vec(reply).unwrap_or_default()));
        };
        let send_data = |out: &mpsc::UnboundedSender<(u8, Vec<u8>)>, id: u32, bytes: &[u8]| {
            let mut payload = Vec::with_capacity(4 + bytes.len());
            payload.extend_from_slice(&id.to_le_bytes());
            payload.extend_from_slice(bytes);
            let _ = out.send((KIND_OUTPUT, payload));
        };

        loop {
            tokio::select! {
                frame = protocol::read_frame(&mut reader) => {
                    let Some((kind, body)) = frame? else { break };
                    match kind {
                        KIND_INPUT => {
                            if let Some((id, bytes)) = protocol::split_data(&body) {
                                let _ = self.registry.lock().unwrap().write(id, bytes);
                            }
                        }
                        KIND_JSON => {
                            let Ok(req) = serde_json::from_slice::<Request>(&body) else { continue };
                            match req {
                                Request::Hello { .. } => {}
                                Request::List => {
                                    let sessions = self.registry.lock().unwrap().list();
                                    send_json(&out_tx, &Reply::Sessions { sessions });
                                }
                                Request::Spawn { req, spawn } => {
                                    let hook_env = self.hook_env.lock().unwrap().clone();
                                    let reply = match Registry::spawn(&self.registry, spawn, &hook_env) {
                                        Ok(id) => Reply::Ok { req, id: Some(id), path: None },
                                        Err(error) => Reply::Err { req, error },
                                    };
                                    send_json(&out_tx, &reply);
                                }
                                Request::Attach { req, id, cols, rows } => {
                                    let result = self.registry.lock().unwrap().attach(id, tx.clone(), cols, rows);
                                    match result {
                                        Ok((replay, exited)) => {
                                            send_json(&out_tx, &Reply::Ok { req, id: Some(id), path: None });
                                            send_json(&out_tx, &Reply::Replaying { id });
                                            // In chunks: one 1 MiB frame would stall every other session.
                                            for chunk in replay.chunks(64 * 1024) {
                                                send_data(&out_tx, id, chunk);
                                            }
                                            send_json(&out_tx, &Reply::Live { id });
                                            if let Some(code) = exited {
                                                send_json(&out_tx, &Reply::Exit { id, code: Some(code) });
                                            }
                                        }
                                        Err(error) => send_json(&out_tx, &Reply::Err { req, error }),
                                    }
                                }
                                Request::Answer { pending, allow } => self.hooks.answer(&pending, allow),
                                Request::Focus { focused } => self.hooks.set_focused(focused),
                                Request::Detach { id } => self.registry.lock().unwrap().detach(id),
                                Request::Resize { id, cols, rows } => {
                                    let _ = self.registry.lock().unwrap().resize(id, cols, rows);
                                }
                                Request::Kill { id } => {
                                    let _ = self.registry.lock().unwrap().kill(id);
                                }
                                Request::LogStart { req, id, path } => {
                                    let reply = match self.registry.lock().unwrap().log_start(id, path) {
                                        Ok(path) => Reply::Ok { req, id: Some(id), path: Some(path) },
                                        Err(error) => Reply::Err { req, error },
                                    };
                                    send_json(&out_tx, &reply);
                                }
                                Request::LogStop { id } => self.registry.lock().unwrap().log_stop(id),
                                Request::Shutdown => {
                                    let _ = self.shutdown.send(true);
                                    break;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                event = events.recv() => {
                    match event {
                        Some(Event::Output { id, bytes }) => send_data(&out_tx, id, &bytes),
                        Some(Event::Exit { id, code }) => send_json(&out_tx, &Reply::Exit { id, code }),
                        None => break,
                    }
                }
                agent = agent_events.recv() => {
                    if let Ok(e) = agent {
                        send_json(&out_tx, &Reply::Agent {
                            pane: e.pane,
                            state: e.state,
                            session_id: e.session_id,
                            detail: e.detail,
                            pending_id: e.pending_id,
                            options: e.options,
                            tool: e.tool,
                            tool_input: e.tool_input,
                            agent_id: e.agent_id,
                            agent_kind: e.agent_kind,
                            agent_task: e.agent_task,
                            agent_event: e.agent_event,
                            agent_ref: e.agent_ref,
                            agent_parent: e.agent_parent,
                            mode: e.mode,
                        });
                    }
                }
            }
        }

        // The window went away: its sessions keep running, just unwatched. And nobody is
        // looking any more — a crash while focused used to leave `focused: true` behind, so a
        // permission prompt fell open after the SHORT hold at exactly the moment there was no
        // window to answer it and the long hold was the whole point.
        self.hooks.set_focused(false);
        self.registry.lock().unwrap().detach_all_for(&tx);
        drop(out_tx);
        let _ = writer_task.await;
        Ok(())
    }
}
