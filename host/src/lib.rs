//! The session host. Shells belong to the process that started them, and on Windows nothing
//! can change that — so the window must not be that process. This crate is the other one: a
//! headless server that owns every pty, keeps the last megabyte each one printed, and talks to
//! the window over a local socket. Close the window, update the app, crash — the shells live.

pub mod protocol;
pub mod ring;
pub mod modes;
pub mod registry;
pub mod server;
pub mod client;
pub mod logins;
pub mod agent;
pub mod hooks;
pub mod install;
pub mod cli;

use std::path::PathBuf;

/// Where the host advertises itself: the socket name and the token a client must present.
/// Lives in the app's own config dir, which is user-only on Windows, so nobody else on the
/// machine can learn the name or the token.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Advert {
    pub socket: String,
    pub token: String,
    /// Minted at boot. A client only attaches to ids it saved under the same instance — a
    /// restarted host restarts its counter, and a stale id must never land on someone else's shell.
    pub instance: String,
    pub pid: u32,
    pub version: String,
}

pub fn advert_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join("host.json")
}

pub fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
