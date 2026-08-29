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

/// How many superseded ports stay listened-to. Four is a couple of days of host restarts; a
/// session older than that has almost certainly been restarted itself.
const KEEP_PREVIOUS: usize = 4;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HookAddr {
    pub port: u16,
    pub token: String,
    /// Ports this host advertised before `port`, newest first — and still listens on. A session
    /// bakes its hook URL in at startup and keeps it for life, so a port we stop answering is a
    /// session whose supervision is dead AND which prints a connection error into the user's
    /// prompt on every event. Missing in files written before this existed: `default`.
    #[serde(default)]
    pub previous: Vec<u16>,
}

impl HookAddr {
    /// The superseded ports worth binding alongside `port`.
    pub fn also_bind(&self) -> Vec<u16> {
        self.previous.clone()
    }

    /// The `previous` list for a run that ended up on `port`: whatever the last run advertised,
    /// then its own history, newest first, without duplicates or the port now in use.
    pub fn roll(port: u16, last: Option<&HookAddr>) -> Vec<u16> {
        let mut out = Vec::new();
        if let Some(a) = last {
            for p in std::iter::once(a.port).chain(a.previous.iter().copied()) {
                if p != port && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        out.truncate(KEEP_PREVIOUS);
        out
    }
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
        let addr = HookAddr { port: 12345, token: "t".into(), previous: vec![999] };
        save(&dir, &addr);
        assert_eq!(load(&dir), Some(addr));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_written_before_previous_existed_still_loads() {
        let dir = std::env::temp_dir().join(format!("obpterm-hookaddr-test-{}", crate::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), r#"{"port":4242,"token":"t"}"#).unwrap();
        let a = load(&dir).expect("an older file is not a corrupt one");
        assert_eq!((a.port, a.previous.len()), (4242, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_history_keeps_the_ports_sessions_may_still_be_posting_to() {
        // Run 1 took 100. Run 2 could not reclaim it and took 200: sessions from run 1 are still
        // posting to 100, so it stays bound. Run 3 takes 300 and both are still worth answering.
        let one = HookAddr { port: 100, token: "t".into(), previous: vec![] };
        let two = HookAddr { port: 200, token: "t".into(), previous: HookAddr::roll(200, Some(&one)) };
        assert_eq!(two.previous, vec![100]);
        let three = HookAddr::roll(300, Some(&two));
        assert_eq!(three, vec![200, 100]);

        // Reclaiming the port it wanted must not list that port as its own predecessor.
        let back = HookAddr::roll(200, Some(&two));
        assert_eq!(back, vec![100], "the port in use is never in its own history");

        // And the list is bounded, oldest dropped first.
        let mut a = HookAddr { port: 1, token: "t".into(), previous: vec![] };
        for p in 2..=9u16 {
            a = HookAddr { port: p, token: "t".into(), previous: HookAddr::roll(p, Some(&a)) };
        }
        assert_eq!(a.previous, vec![8, 7, 6, 5], "four back, newest first");
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
