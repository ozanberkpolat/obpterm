//! The hook listener: Claude Code's hooks POST their payloads here, and this is how the app
//! knows a session is working, done, or waiting on a permission — from the horse's mouth,
//! not from watching bytes.
//!
//! It lives in the host because hooks must survive window restarts. A tiny hand-rolled
//! HTTP/1.1 loop on loopback: one POST, a token and pane id on headers (see `parse_pane` for the
//! older path-based shape still accepted), nothing else — a real HTTP dependency would be more
//! code than this file.
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
/// How long a held permission request waits while someone is looking at the window: the in-pane
/// prompt is right there, so falling open quickly is the kind thing to do.
pub const ANSWER_WAIT: Duration = Duration::from_secs(40);
/// And while nobody is. Long enough to reach a phone or walk back to the desk, short enough
/// that a session you have forgotten is not stuck for an hour. The hook's own timeout in
/// `settings.json` is set above this — a hold longer than that would just be killed.
pub const ANSWER_WAIT_AWAY: Duration = Duration::from_secs(180);

pub struct HookHub {
    pub token: String,
    /// Pending permission requests by pending-id: completing one answers the held POST.
    pending: Mutex<HashMap<String, oneshot::Sender<Option<bool>>>>,
    /// Where normalized events go — the server forwards them to the connected window.
    events: tokio::sync::broadcast::Sender<AgentEvent>,
    /// Whether the window is in front, as the window last reported. Starts false: with no
    /// window attached at all, nobody is looking, which is exactly the long-hold case.
    focused: std::sync::atomic::AtomicBool,
}

impl HookHub {
    pub fn new(token: String) -> Arc<Self> {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self {
            token,
            pending: Mutex::new(HashMap::new()),
            events,
            focused: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// The window came to the front, or left it.
    pub fn set_focused(&self, focused: bool) {
        self.focused.store(focused, std::sync::atomic::Ordering::Relaxed);
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

    /// Binds on `preferred` — the port an http hook's URL was last built with — and on `also`,
    /// the ports earlier runs advertised. Returns the port new hooks should be pointed at.
    ///
    /// Both halves exist because a session snapshots its hook URL at startup and keeps it for
    /// the rest of its life (Claude Code's documented behaviour). If the host comes back on a
    /// different port, every session already running posts into a closed socket — supervision
    /// silently dead, and a connection error printed into the user's prompt on every event.
    /// So: try hard not to move (`bind_preferred`), and keep answering where we used to.
    pub async fn listen(self: Arc<Self>, preferred: Option<u16>, also: &[u16]) -> std::io::Result<u16> {
        let listener = match preferred {
            Some(p) => bind_preferred(p).await?,
            None => TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        Arc::clone(&self).accept_on(listener);
        for &old in also {
            if old == port {
                continue;
            }
            match TcpListener::bind(("127.0.0.1", old)).await {
                Ok(l) => Arc::clone(&self).accept_on(l),
                // Someone else has it now. Nothing to do: those sessions were already lost.
                Err(e) => eprintln!("obpterm-host: not re-binding old hook port {old}: {e}"),
            }
        }
        Ok(port)
    }

    fn accept_on(self: Arc<Self>, listener: TcpListener) {
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                let hub = Arc::clone(&self);
                tokio::spawn(async move {
                    let _ = hub.handle(stream).await;
                });
            }
        });
    }

    async fn handle(&self, mut stream: tokio::net::TcpStream) -> std::io::Result<()> {
        // Read until the end of a small request; hooks send one POST and wait.
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        // The head is searched for — and parsed — ONCE. An Agent call's PreToolUse carries the
        // whole sub-agent prompt, so the body arrives over many reads; re-scanning the whole
        // buffer each time made the search quadratic in the payload, and `scanned` keeps each
        // scan to what that read added (less three bytes, so a `\r\n\r\n` straddling a read
        // boundary is still found).
        let mut scanned = 0usize;
        let mut head: Option<(String, HashMap<String, String>, usize, usize)> = None;
        let (path, headers, body) = loop {
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.len() > 1024 * 1024 {
                return respond(&mut stream, 413, "").await;
            }
            if head.is_none() {
                let from = scanned.saturating_sub(3);
                scanned = buf.len();
                if let Some(head_end) = find(&buf[from..], b"\r\n\r\n").map(|i| i + from) {
                    let text = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    let mut lines = text.lines();
                    let first = lines.next().unwrap_or_default().to_string();
                    let path = first.split_whitespace().nth(1).unwrap_or_default().to_string();
                    let headers: HashMap<String, String> =
                        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
                    let length = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                    head = Some((path, headers, head_end + 4, length));
                }
            }
            if let Some((path, headers, body_start, length)) = &head {
                if buf.len() >= body_start + length {
                    break (path.clone(), headers.clone(), buf[*body_start..body_start + length].to_vec());
                }
            }
        };

        // v3 shape: token + pane on headers (`X-OBPTerm-Token`/`X-OBPTerm-Pane`), path is bare
        // `/hook` — an http hook has no per-pane URL to put them in (see install.rs). v2 and
        // earlier shape kept so a settings.json a not-yet-restarted host wrote still reaches us:
        // `/hook/<token>/<pane>`, no headers, from a `command` hook's own spawned process.
        // Anything that fits neither — a plain terminal's Claude Code, with no OBPTERM_PANE_ID
        // to interpolate — is not ours; 200 and nothing, the same silence the old shell guard
        // gave it.
        let Some((token, pane)) = parse_pane(&path, &headers) else {
            return respond(&mut stream, 200, "").await;
        };
        if token != self.token {
            return respond(&mut stream, 403, "").await;
        }
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
            let wait = if self.focused.load(std::sync::atomic::Ordering::Relaxed) { ANSWER_WAIT } else { ANSWER_WAIT_AWAY };
            let verdict = tokio::time::timeout(wait, rx).await.ok().and_then(|r| r.ok()).flatten();
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

/// How long to keep trying for the port we want before settling for another. "Restart host"
/// kills the old host and starts the new one straight away, so the port it is meant to reclaim
/// is routinely still held for a moment by a process on its way out. Giving up on the first
/// refusal — which is what the first version of this did — moved the port for no reason and
/// stranded every open session on the old one.
const BIND_RETRY: Duration = Duration::from_secs(2);
const BIND_RETRY_GAP: Duration = Duration::from_millis(100);

async fn bind_preferred(port: u16) -> std::io::Result<TcpListener> {
    let deadline = tokio::time::Instant::now() + BIND_RETRY;
    loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(e) => {
                if tokio::time::Instant::now() >= deadline {
                    eprintln!("obpterm-host: hook port {port} stayed busy ({e}); taking a new one");
                    return TcpListener::bind(("127.0.0.1", 0)).await;
                }
                tokio::time::sleep(BIND_RETRY_GAP).await;
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The token and pane a request carried, whichever shape it used — `None` when it is neither
/// (an unresolved `$OBPTERM_PANE_ID` interpolates to an empty header, exactly like a plain
/// terminal's Claude Code that never had the variable at all).
fn parse_pane(path: &str, headers: &HashMap<String, String>) -> Option<(String, u32)> {
    if let (Some(token), Some(pane)) = (headers.get("x-obpterm-token"), headers.get("x-obpterm-pane")) {
        return Some((token.clone(), pane.parse().ok()?));
    }
    let mut parts = path.trim_start_matches('/').split('/');
    if parts.next() != Some("hook") {
        return None;
    }
    let token = parts.next()?.to_string();
    let pane = parts.next()?.parse().ok()?;
    Some((token, pane))
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
        post_with(port, path, &[], body).await
    }

    /// The v3 shape: token and pane on headers instead of the path — what an `http` hook
    /// actually sends (Claude Code builds the request itself; nothing here constructs it by
    /// hand outside these tests).
    async fn post_with(port: u16, path: &str, extra_headers: &[(&str, &str)], body: &str) -> (u16, String) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let extra: String = extra_headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
        let req = format!("POST {path} HTTP/1.1\r\nhost: x\r\n{extra}content-length: {}\r\n\r\n{body}", body.len());
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
        let port = Arc::clone(&hub).listen(None, &[]).await.unwrap();
        let mut events = hub.subscribe();

        let (code, _) = post(port, "/hook/tok/5", r#"{"hook_event_name":"Stop","session_id":"s9","last_assistant_message":"done"}"#).await;
        assert_eq!(code, 200);
        let e = events.recv().await.unwrap();
        assert_eq!((e.pane, e.state.as_str(), e.session_id.as_deref()), (5, "done", Some("s9")));

        let (code, _) = post(port, "/hook/WRONG/5", r#"{"hook_event_name":"Stop"}"#).await;
        assert_eq!(code, 403);
    }

    #[tokio::test]
    async fn the_header_shape_works_the_same_as_the_legacy_path_one() {
        let hub = HookHub::new("tok".into());
        let port = Arc::clone(&hub).listen(None, &[]).await.unwrap();
        let mut events = hub.subscribe();

        let (code, _) = post_with(
            port,
            "/hook",
            &[("X-OBPTerm-Token", "tok"), ("X-OBPTerm-Pane", "5")],
            r#"{"hook_event_name":"Stop","session_id":"s9","last_assistant_message":"done"}"#,
        )
        .await;
        assert_eq!(code, 200);
        let e = events.recv().await.unwrap();
        assert_eq!((e.pane, e.state.as_str()), (5, "done"));

        let (code, _) = post_with(port, "/hook", &[("X-OBPTerm-Token", "WRONG"), ("X-OBPTerm-Pane", "5")], r#"{"hook_event_name":"Stop"}"#).await;
        assert_eq!(code, 403);
    }

    #[tokio::test]
    async fn a_payload_far_bigger_than_one_read_still_parses() {
        // An Agent call's PreToolUse carries the whole sub-agent prompt — far more than the
        // 4 KB read buffer, so the header scan runs across many reads. It used to rescan the
        // entire accumulated buffer each time (quadratic in the payload); it now resumes from
        // where it left off, with a three-byte overlap so a `\r\n\r\n` split across a read
        // boundary is still found.
        let hub = HookHub::new("tok".into());
        let port = Arc::clone(&hub).listen(None, &[]).await.unwrap();
        let mut events = hub.subscribe();

        let prompt = "x".repeat(200_000);
        let body = format!(r#"{{"hook_event_name":"Stop","session_id":"big","last_assistant_message":"{prompt}"}}"#);
        let (code, _) = post_with(port, "/hook", &[("X-OBPTerm-Token", "tok"), ("X-OBPTerm-Pane", "9")], &body).await;
        assert_eq!(code, 200);
        let e = events.recv().await.unwrap();
        assert_eq!((e.pane, e.state.as_str(), e.session_id.as_deref()), (9, "done", Some("big")));
        assert!(e.detail.is_some_and(|d| d.len() < 400), "the message is still clipped, not forwarded whole");
    }

    #[tokio::test]
    async fn a_session_outside_any_pane_is_dropped_silently_not_refused() {
        // An unresolved `$OBPTERM_PANE_ID` interpolates to an empty header — a plain terminal's
        // Claude Code, not one of ours. The old shell hook never even spawned for this case;
        // the http hook always gets a response, but it must be a quiet 200, not an error.
        let hub = HookHub::new("tok".into());
        let port = Arc::clone(&hub).listen(None, &[]).await.unwrap();
        let (code, _) = post_with(port, "/hook", &[("X-OBPTerm-Token", "tok"), ("X-OBPTerm-Pane", "")], r#"{"hook_event_name":"Stop"}"#).await;
        assert_eq!(code, 200);
    }

    #[tokio::test]
    async fn a_permission_request_waits_for_the_rail_and_carries_the_verdict() {
        let hub = HookHub::new("t".into());
        let port = Arc::clone(&hub).listen(None, &[]).await.unwrap();
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
