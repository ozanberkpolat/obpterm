//! Port + token for the http hook listener, persisted across host restarts.
//!
//! Claude Code snapshots hooks into a session's own process at startup (see `install.rs`'s
//! `hook_object` doc comment), so the URL and token baked into `settings.json` have to keep
//! answering across a routine host restart — crash, self-update, "Restart host" — or every
//! already-open pane goes silently unsupervised until that session itself is restarted. The old
//! `command` hook never had this problem: it spawned a fresh process per event, which read the
//! CURRENT port from `hook-endpoint.env` every time (see `server::start_hooks`). An http hook
//! has no such indirection — the address is a literal string sitting in `settings.json` — so the
//! host's job is to keep that address alive across its own restarts instead.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HookAddr {
    pub port: u16,
    pub token: String,
}

fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("hook.json")
}

/// What the previous run left behind, if anything and if it still parses. `server::start_hooks`
/// tries to rebind this exact port; failing that, a fresh one is minted and this file rewritten,
/// which only matters to panes that open (or restart) after this run.
pub fn load(config_dir: &Path) -> Option<HookAddr> {
    let text = std::fs::read_to_string(path(config_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Persists the address this run actually bound — which may differ from what `load` returned.
pub fn save(config_dir: &Path, addr: &HookAddr) {
    if let Ok(text) = serde_json::to_string_pretty(addr) {
        let _ = std::fs::write(path(config_dir), text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("obpterm-hookaddr-test-{}", crate::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).is_none(), "nothing written yet");
        let addr = HookAddr { port: 12345, token: "t".into() };
        save(&dir, &addr);
        assert_eq!(load(&dir), Some(addr));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_file_reads_as_absent_not_an_error() {
        let dir = std::env::temp_dir().join(format!("obpterm-hookaddr-test-{}", crate::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), "{not json").unwrap();
        assert!(load(&dir).is_none(), "a fresh token/port is minted rather than the host failing to start");
        std::fs::remove_dir_all(&dir).ok();
    }
}
