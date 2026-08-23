//! The hook listener: Claude Code's hooks POST their payloads here, and this is how the app
//! knows a session is working, done, or waiting on a permission — from the horse's mouth,
//! not from watching bytes.
//!
//! It lives in the host because hooks must survive window restarts. A tiny hand-rolled
//! HTTP/1.1 loop on loopback: one POST shape, a token in the path, nothing else — a real HTTP
//! dependency would be more code than this file.
//!
//! Approvals ride the response: a PermissionRequest hook's POST is HELD OPEN until the window
//! answers or the timeout passes. An "allow"/"deny" completes it with the decision JSON that
//! Claude Code reads from the hook's stdout; a timeout completes it empty, and Claude shows
//! its normal in-pane prompt — fail-open, always.

use crate::agent::{normalize, AgentEvent};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// How long a permission request waits for an answer from the rail before falling open.
pub const ANSWER_WAIT: Duration = Duration::from_secs(40);

pub struct HookHub {
    pub token: String,
    /// Pending permission requests by pending-id: completing one answers the held POST.
    pending: Mutex<HashMap<String, oneshot::Sender<Option<bool>>>>,
    /// Where normalized events go — the server forwards them to the connected window.
    events: tokio::sync::broadcast::Sender<AgentEvent>,
}

impl HookHub {
    pub fn new(token: String) -> Arc<Self> {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self { token, pending: Mutex::new(HashMap::new()), events })
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AgentEvent> {
        self.events.subscribe()
    }

    /// The window's verdict on a held permission request. `None` = pass, show the normal prompt.
    pub fn answer(&self, pending_id: &str, allow: Option<bool>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(pending_id) {
            let _ = tx.send(allow);
        }
    }

    /// Binds on an ephemeral loopback port; returns it.
    pub async fn listen(self: Arc<Self>) -> std::io::Result<u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                let hub = Arc::clone(&self);
                tokio::spawn(async move {
                    let _ = hub.handle(stream).await;
                });
            }
        });
        Ok(port)
    }

    async fn handle(&self, mut stream: tokio::net::TcpStream) -> std::io::Result<()> {
        // Read until the end of a small request; hooks send one POST and wait.
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        let (path, body) = loop {
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.len() > 1024 * 1024 {
                return respond(&mut stream, 413, "").await;
            }
            if let Some(head_end) = find(&buf, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                let length = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().ok()))
                    .flatten()
                    .unwrap_or(0);
                let body_start = head_end + 4;
                if buf.len() >= body_start + length {
                    let first = head.lines().next().unwrap_or_default().to_string();
                    let path = first.split_whitespace().nth(1).unwrap_or_default().to_string();
                    break (path, buf[body_start..body_start + length].to_vec());
                }
            }
        };

        // /hook/<token>/<pane>
        let mut parts = path.trim_start_matches('/').split('/');
        if parts.next() != Some("hook") || parts.next() != Some(self.token.as_str()) {
            return respond(&mut stream, 403, "").await;
        }
        let Some(pane) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
            return respond(&mut stream, 400, "").await;
        };
        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return respond(&mut stream, 400, "").await;
        };
        let Some(mut event) = normalize(pane, &payload) else {
            return respond(&mut stream, 200, "").await;
        };

        if event.state == "blocked" {
            // Hold the POST open; the rail can answer it, or it falls open.
            let pending_id = format!("p{}-{}", pane, crate::random_hex(4));
            event.pending_id = Some(pending_id.clone());
            let (tx, rx) = oneshot::channel();
            self.pending.lock().unwrap().insert(pending_id.clone(), tx);
            let _ = self.events.send(event);
            let verdict = tokio::time::timeout(ANSWER_WAIT, rx).await.ok().and_then(|r| r.ok()).flatten();
            self.pending.lock().unwrap().remove(&pending_id);
            let body = match verdict {
                Some(true) => r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#,
                Some(false) => r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied from the OBPTerm rail"}}}"#,
                None => "",
            };
            return respond(&mut stream, 200, body).await;
        }

        let _ = self.events.send(event);
        respond(&mut stream, 200, "").await
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn respond(stream: &mut tokio::net::TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        _ => "Payload Too Large",
    };
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn post(port: u16, path: &str, body: &str) -> (u16, String) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!("POST {path} HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let code = out.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (code, body)
    }

    #[tokio::test]
    async fn events_flow_and_a_bad_token_is_refused() {
        let hub = HookHub::new("tok".into());
        let port = Arc::clone(&hub).listen().await.unwrap();
        let mut events = hub.subscribe();

        let (code, _) = post(port, "/hook/tok/5", r#"{"hook_event_name":"Stop","session_id":"s9","last_assistant_message":"done"}"#).await;
        assert_eq!(code, 200);
        let e = events.recv().await.unwrap();
        assert_eq!((e.pane, e.state.as_str(), e.session_id.as_deref()), (5, "done", Some("s9")));

        let (code, _) = post(port, "/hook/WRONG/5", r#"{"hook_event_name":"Stop"}"#).await;
        assert_eq!(code, 403);
    }

    #[tokio::test]
    async fn a_permission_request_waits_for_the_rail_and_carries_the_verdict() {
        let hub = HookHub::new("t".into());
        let port = Arc::clone(&hub).listen().await.unwrap();
        let mut events = hub.subscribe();

        let answerer = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                let e = events.recv().await.unwrap();
                assert_eq!(e.state, "blocked");
                hub.answer(e.pending_id.as_deref().unwrap(), Some(true));
            })
        };
        let (code, body) = post(port, "/hook/t/3", r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"cargo test"}}"#).await;
        assert_eq!(code, 200);
        assert!(body.contains(r#""behavior":"allow""#), "the held POST carried the verdict: {body}");
        answerer.await.unwrap();
    }
}
