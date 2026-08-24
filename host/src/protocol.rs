//! Frames on the socket: a 4-byte little-endian length, then one byte of kind, then the payload.
//! Kind 0 is a JSON message; kind 1 is raw pty output for the session named in the first four
//! bytes; kind 2 is raw keyboard input for a session, the same shape the other way.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const KIND_JSON: u8 = 0;
pub const KIND_OUTPUT: u8 = 1;
pub const KIND_INPUT: u8 = 2;

/// Largest frame either side will accept. Output is chunked well below this.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

/// What a shell was started as — the same shape the app's config calls a Profile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Spawn {
    pub exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Request {
    /// Must be the first frame. A wrong token closes the connection.
    Hello { token: String },
    List,
    Spawn { req: u32, spawn: Spawn },
    /// Replay what the session printed, then stream it. Resizing to the given size afterwards
    /// makes full-screen programs repaint, which is what turns a replay into a live screen.
    Attach { req: u32, id: u32, cols: u16, rows: u16 },
    Detach { id: u32 },
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    LogStart { req: u32, id: u32, path: String },
    LogStop { id: u32 },
    /// The rail's verdict on a held permission request; None passes it to the normal prompt.
    Answer { pending: String, allow: Option<bool> },
    /// End every shell and exit. Closing the window is a detach, never this.
    Shutdown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionInfo {
    pub id: u32,
    pub exe: String,
    pub cwd: Option<String>,
    pub attached: bool,
    pub exited: Option<u32>,
    pub started_at: i64,
    /// Epoch ms of the last byte the shell printed.
    pub last_output: i64,
    /// A BEL arrived while nobody was attached. Cleared by the next attach.
    pub bell: bool,
    /// The latest hook-derived state, so a reconnecting window starts truthful.
    #[serde(default)]
    pub agent_state: Option<String>,
    #[serde(default)]
    pub agent_detail: Option<String>,
    /// Claude's own session id, learned from hooks — what `claude --resume` needs.
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// The shell's root process id, so a window can weigh the process tree (RAM per session).
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Reply {
    Hello { instance: String, version: String },
    Sessions { sessions: Vec<SessionInfo> },
    Ok { req: u32, id: Option<u32>, path: Option<String> },
    Err { req: u32, error: String },
    /// The session's shell ended. Sent to whoever is attached.
    Exit { id: u32, code: Option<u32> },
    /// Everything between this and `Live` is replayed history, not fresh output.
    Replaying { id: u32 },
    Live { id: u32 },
    /// A Claude Code hook fired for this pane. The window's state machine takes it from here.
    Agent {
        pane: u32,
        state: String,
        session_id: Option<String>,
        detail: Option<String>,
        pending_id: Option<String>,
        options: Vec<String>,
    },
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let len = (payload.len() + 1) as u32;
    w.write_all(&len.to_le_bytes()).await?;
    w.write_all(&[kind]).await?;
    w.write_all(payload).await?;
    w.flush().await
}

pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_frame(w, KIND_JSON, &bytes).await
}

/// A data frame: the session id, then the bytes.
pub async fn write_data<W: AsyncWrite + Unpin>(w: &mut W, kind: u8, id: u32, bytes: &[u8]) -> std::io::Result<()> {
    let mut payload = Vec::with_capacity(4 + bytes.len());
    payload.extend_from_slice(&id.to_le_bytes());
    payload.extend_from_slice(bytes);
    write_frame(w, kind, &payload).await
}

/// One frame, decoded as far as its kind. `None` at a clean end of stream.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bad frame length {len}")));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    let kind = body[0];
    body.remove(0);
    Ok(Some((kind, body)))
}

/// Splits a data payload back into (id, bytes).
pub fn split_data(payload: &[u8]) -> Option<(u32, &[u8])> {
    if payload.len() < 4 {
        return None;
    }
    let id = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    Some((id, &payload[4..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_through_a_pipe() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_json(&mut a, &Request::Resize { id: 7, cols: 80, rows: 24 }).await.unwrap();
        write_data(&mut a, KIND_OUTPUT, 7, b"hello").await.unwrap();
        let (kind, body) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(kind, KIND_JSON);
        assert_eq!(serde_json::from_slice::<Request>(&body).unwrap(), Request::Resize { id: 7, cols: 80, rows: 24 });
        let (kind, body) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(kind, KIND_OUTPUT);
        assert_eq!(split_data(&body), Some((7, &b"hello"[..])));
        drop(a);
        assert!(read_frame(&mut b).await.unwrap().is_none(), "a closed peer reads as end of stream");
    }

    #[tokio::test]
    async fn an_absurd_length_is_refused_before_allocating() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&(u32::MAX).to_le_bytes()).await.unwrap();
        assert!(read_frame(&mut b).await.is_err());
    }
}
