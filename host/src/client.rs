//! The window's side: one connection to the host, requests matched to replies by number,
//! output delivered per session to whoever attached.

use crate::protocol::{self, Reply, Request, Spawn, KIND_INPUT, KIND_JSON, KIND_OUTPUT};
use crate::Advert;
use interprocess::local_socket::tokio::prelude::*;
use interprocess::local_socket::GenericNamespaced;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{mpsc, oneshot};

/// Output and exit for one attached session, in order. Replay comes first, framed by
/// `Replaying`/`Live` so the window can tell history from fresh bytes.
#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    Replaying,
    Live,
    Output(Vec<u8>),
    Exit(Option<u32>),
}

/// What the reader task needs. Kept apart from `Client` so dropping the client really closes
/// the socket — a task holding the whole client would keep it open forever, and the host would
/// never learn the window went away.
#[derive(Default)]
struct Inner {
    pending: Mutex<HashMap<u32, oneshot::Sender<Reply>>>,
    watchers: Mutex<HashMap<u32, mpsc::UnboundedSender<Delivery>>>,
    list_waiters: Mutex<Vec<oneshot::Sender<Vec<protocol::SessionInfo>>>>,
}

impl Inner {
    fn deliver(&self, id: u32, d: Delivery) {
        if let Some(tx) = self.watchers.lock().unwrap().get(&id) {
            let _ = tx.send(d);
        }
    }
}

pub struct Client {
    pub instance: String,
    pub version: String,
    out: mpsc::UnboundedSender<(u8, Vec<u8>)>,
    inner: Arc<Inner>,
    next_req: Mutex<u32>,
    /// Flips to true when the socket drops: the host died, or was shut down.
    pub gone: tokio::sync::watch::Receiver<bool>,
}

impl Client {
    pub async fn connect(advert: &Advert) -> std::io::Result<Arc<Client>> {
        let name = advert.socket.clone().to_ns_name::<GenericNamespaced>()?;
        let conn = interprocess::local_socket::tokio::Stream::connect(name).await?;
        let (rx_half, tx_half) = conn.split();
        let mut reader = BufReader::new(rx_half);
        let mut writer = BufWriter::new(tx_half);

        protocol::write_json(&mut writer, &Request::Hello { token: advert.token.clone() }).await?;
        let hello = match protocol::read_frame(&mut reader).await? {
            Some((KIND_JSON, body)) => serde_json::from_slice::<Reply>(&body).ok(),
            _ => None,
        };
        let Some(Reply::Hello { instance, version }) = hello else {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "host refused the token"));
        };

        let (out, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
        tokio::spawn(async move {
            while let Some((kind, payload)) = out_rx.recv().await {
                if protocol::write_frame(&mut writer, kind, &payload).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });

        let (gone_tx, gone) = tokio::sync::watch::channel(false);
        let inner = Arc::new(Inner::default());
        let client = Arc::new(Client { instance, version, out, inner: Arc::clone(&inner), next_req: Mutex::new(0), gone });

        let me = inner;
        tokio::spawn(async move {
            loop {
                let frame = match protocol::read_frame(&mut reader).await {
                    Ok(Some(f)) => f,
                    _ => break,
                };
                match frame {
                    (KIND_OUTPUT, body) => {
                        if let Some((id, bytes)) = protocol::split_data(&body) {
                            me.deliver(id, Delivery::Output(bytes.to_vec()));
                        }
                    }
                    (KIND_JSON, body) => {
                        let Ok(reply) = serde_json::from_slice::<Reply>(&body) else { continue };
                        match reply {
                            Reply::Ok { req, .. } | Reply::Err { req, .. } => {
                                if let Some(tx) = me.pending.lock().unwrap().remove(&req) {
                                    let _ = tx.send(reply);
                                }
                            }
                            Reply::Sessions { sessions } => {
                                for tx in me.list_waiters.lock().unwrap().drain(..) {
                                    let _ = tx.send(sessions.clone());
                                }
                            }
                            Reply::Replaying { id } => me.deliver(id, Delivery::Replaying),
                            Reply::Live { id } => me.deliver(id, Delivery::Live),
                            Reply::Exit { id, code } => {
                                me.deliver(id, Delivery::Exit(code));
                                me.watchers.lock().unwrap().remove(&id);
                            }
                            Reply::Hello { .. } => {}
                        }
                    }
                    _ => {}
                }
            }
            let _ = gone_tx.send(true);
        });

        Ok(client)
    }

    fn req(&self) -> u32 {
        let mut n = self.next_req.lock().unwrap();
        *n += 1;
        *n
    }

    fn send_json(&self, value: &Request) {
        let _ = self.out.send((KIND_JSON, serde_json::to_vec(value).unwrap_or_default()));
    }

    async fn call(&self, req: u32, request: Request) -> Result<Reply, String> {
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(req, tx);
        self.send_json(&request);
        rx.await.map_err(|_| "host went away".to_string())
    }

    pub async fn list(&self) -> Result<Vec<protocol::SessionInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.inner.list_waiters.lock().unwrap().push(tx);
        self.send_json(&Request::List);
        rx.await.map_err(|_| "host went away".to_string())
    }

    pub async fn spawn(&self, spawn: Spawn) -> Result<u32, String> {
        let req = self.req();
        match self.call(req, Request::Spawn { req, spawn }).await? {
            Reply::Ok { id: Some(id), .. } => Ok(id),
            Reply::Err { error, .. } => Err(error),
            other => Err(format!("unexpected reply {other:?}")),
        }
    }

    /// Routes the session's replay and live output to `tx`.
    pub async fn attach(&self, id: u32, cols: u16, rows: u16, tx: mpsc::UnboundedSender<Delivery>) -> Result<(), String> {
        self.inner.watchers.lock().unwrap().insert(id, tx);
        let req = self.req();
        match self.call(req, Request::Attach { req, id, cols, rows }).await? {
            Reply::Ok { .. } => Ok(()),
            Reply::Err { error, .. } => {
                self.inner.watchers.lock().unwrap().remove(&id);
                Err(error)
            }
            other => Err(format!("unexpected reply {other:?}")),
        }
    }

    pub fn detach(&self, id: u32) {
        self.inner.watchers.lock().unwrap().remove(&id);
        self.send_json(&Request::Detach { id });
    }

    pub fn write(&self, id: u32, bytes: &[u8]) {
        let mut payload = Vec::with_capacity(4 + bytes.len());
        payload.extend_from_slice(&id.to_le_bytes());
        payload.extend_from_slice(bytes);
        let _ = self.out.send((KIND_INPUT, payload));
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        self.send_json(&Request::Resize { id, cols, rows });
    }

    pub fn kill(&self, id: u32) {
        self.inner.watchers.lock().unwrap().remove(&id);
        self.send_json(&Request::Kill { id });
    }

    pub async fn log_start(&self, id: u32, path: String) -> Result<String, String> {
        let req = self.req();
        match self.call(req, Request::LogStart { req, id, path }).await? {
            Reply::Ok { path: Some(path), .. } => Ok(path),
            Reply::Err { error, .. } => Err(error),
            other => Err(format!("unexpected reply {other:?}")),
        }
    }

    pub fn log_stop(&self, id: u32) {
        self.send_json(&Request::LogStop { id });
    }

    pub fn shutdown(&self) {
        self.send_json(&Request::Shutdown);
    }
}
