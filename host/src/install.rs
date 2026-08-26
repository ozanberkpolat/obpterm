//! Installing the Claude Code hooks: a marked, removable block merged into a settings.json.
//! Pure functions over JSON, so the merge is tested without touching anyone's real config.

use serde_json::{json, Value};

/// Every event the supervision states are derived from.
pub const EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "Notification",
    "PermissionRequest",
    "SessionEnd",
];

/// The sentinel that marks our entries. Bump the suffix when the command changes shape, and
/// old entries are replaced instead of duplicated.
pub const MARK: &str = "# obpterm-hooks v2";

/// How the shell should spell the host's path. The commands run through a POSIX shell on
/// Windows (Git Bash), where a backslash is an escape — so forward slashes, always.
fn shell_path(exe: &str) -> String {
    exe.replace('\\', "/")
}

/// The command itself: one process, which checks for `OBPTERM_PANE_ID` and fails open on its
/// own (see `cli::hook`). It replaces `sh` + `curl` per event — two process creations for every
/// PreToolUse and PostToolUse of every agent, which is what made a fan-out cost so much on
/// Windows. The `[ -n ... ]` guard stays so a plain terminal does not even spawn us.
pub fn hook_command(exe: &str) -> String {
    format!(r#"[ -n "$OBPTERM_PANE_ID" ] && "{}" hook; : {MARK}"#, shell_path(exe))
}

/// True when the settings already carry the current block on every event.
pub fn installed(settings: &Value) -> bool {
    EVENTS.iter().all(|event| {
        settings
            .pointer(&format!("/hooks/{event}"))
            .and_then(|v| v.as_array())
            .is_some_and(|entries| {
                entries.iter().any(|e| {
                    e.get("hooks")
                        .and_then(|h| h.as_array())
                        .is_some_and(|hooks| hooks.iter().any(|h| h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(MARK))))
                })
            })
    })
}

/// True when our installed block is the CURRENT command, not an older one. A settings file
/// written by an earlier version carries the same mark but a stale command; without this the
/// installer would skip it forever and the app would wait on events that never come.
pub fn current(settings: &Value, exe: &str) -> bool {
    let want = hook_command(exe);
    EVENTS.iter().all(|event| {
        settings
            .pointer(&format!("/hooks/{event}"))
            .and_then(|v| v.as_array())
            .is_some_and(|entries| {
                entries.iter().any(|e| {
                    e.get("hooks").and_then(|h| h.as_array()).is_some_and(|hooks| {
                        hooks.iter().any(|h| h.get("command").and_then(|c| c.as_str()) == Some(want.as_str()))
                    })
                })
            })
    })
}

/// Adds (or refreshes) the block, leaving every other hook exactly as it was.
pub fn install(settings: &mut Value, exe: &str) {
    remove(settings);
    if !settings.is_object() {
        *settings = json!({});
    }
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    for event in EVENTS {
        let entries = hooks
            .as_object_mut()
            .unwrap()
            .entry(event)
            .or_insert_with(|| json!([]));
        if !entries.is_array() {
            *entries = json!([]);
        }
        // PermissionRequest's POST is held while the rail decides; give it room.
        let timeout = if event == "PermissionRequest" { 55 } else { 10 };
        entries.as_array_mut().unwrap().push(json!({
            "hooks": [{ "type": "command", "command": hook_command(exe), "timeout": timeout }]
        }));
    }
}

/// Strips every entry of ours, and only ours, from every event.
pub fn remove(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else { return };
    for (_, entries) in hooks.iter_mut() {
        if let Some(list) = entries.as_array_mut() {
            for entry in list.iter_mut() {
                if let Some(inner) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    inner.retain(|h| !h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(MARK)));
                }
            }
            list.retain(|entry| {
                entry
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .is_none_or(|inner| !inner.is_empty())
            });
        }
    }
}

/// Marks our statusLine so it is recognizably ours and never clobbers a user's own.
pub const SL_MARK: &str = "# obpterm-statusline v3";

/// Saves the payload (rate_limits included) where the token meters read it, and prints the
/// model plus both percentages as Claude Code's own status line. POSIX sh, same as the hooks;
/// staleness comes from the file's mtime, so no timestamp needs appending.
pub fn statusline_command(exe: &str) -> String {
    format!(r#""{}" statusline; : {SL_MARK}"#, shell_path(exe))
}

/// True when the statusLine is ours. A user's own statusLine returns false — and install
/// leaves it alone, because there is only one statusLine slot.
pub fn statusline_installed(settings: &Value) -> bool {
    settings
        .pointer("/statusLine/command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.contains(SL_MARK))
}

/// Sets our statusLine only when the slot is empty or already ours. Returns whether it wrote.
pub fn statusline_install(settings: &mut Value, exe: &str) -> bool {
    let foreign = settings.get("statusLine").is_some() && !statusline_installed(settings);
    if foreign {
        return false;
    }
    if !settings.is_object() {
        *settings = json!({});
    }
    let wanted = json!({ "type": "command", "command": statusline_command(exe) });
    if settings.get("statusLine") == Some(&wanted) {
        return false;
    }
    settings.as_object_mut().unwrap().insert("statusLine".into(), wanted);
    true
}

/// Removes the statusLine only when it is ours.
pub fn statusline_remove(settings: &mut Value) -> bool {
    if !statusline_installed(settings) {
        return false;
    }
    settings.as_object_mut().map(|o| o.remove("statusLine"));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the host would live on a real machine; the commands embed it.
    const EXE: &str = "C:/Users/obp/AppData/Local/OBPTerm/host/obpterm-host-9.9.9.exe";

    #[test]
    fn neither_command_spawns_a_shell_pipeline() {
        // The whole point of v0.21.13: one process per event, not eight. If either of these
        // grows a `curl`, a `sed` or a pipe again, an agent fan-out gets expensive on Windows.
        for cmd in [hook_command(EXE), statusline_command(EXE)] {
            for banned in ["curl", "sed", "printf", "|", "$("] {
                assert!(!cmd.contains(banned), "{banned:?} is back in {cmd:?}");
            }
            assert!(cmd.contains(EXE), "the command calls the host binary: {cmd:?}");
        }
    }

    #[test]
    fn install_is_idempotent_and_leaves_other_hooks_alone() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "ntfy send done" }] }]
            }
        });
        install(&mut settings, EXE);
        install(&mut settings, EXE); // twice: must not duplicate
        assert!(installed(&settings));
        let stop = settings.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stop.len(), 2, "the user's own Stop hook plus exactly one of ours");
        assert_eq!(stop[0].pointer("/hooks/0/command").unwrap(), "ntfy send done");
        assert_eq!(settings["model"], "opus", "unrelated settings untouched");

        remove(&mut settings);
        assert!(!installed(&settings));
        let stop = settings.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stop.len(), 1, "only ours removed");
        assert_eq!(stop[0].pointer("/hooks/0/command").unwrap(), "ntfy send done");
    }

    #[test]
    fn statusline_respects_a_foreign_one_and_round_trips() {
        // Empty file: installs.
        let mut settings = json!({});
        assert!(statusline_install(&mut settings, EXE));
        assert!(statusline_installed(&settings));
        assert!(!statusline_install(&mut settings, EXE), "idempotent: a second install writes nothing");
        // Ours is removable…
        assert!(statusline_remove(&mut settings));
        assert!(settings.get("statusLine").is_none());
        // …a user's own is neither replaced nor removed.
        let mut theirs = json!({ "statusLine": { "type": "command", "command": "starship prompt" } });
        assert!(!statusline_install(&mut theirs, EXE));
        assert!(!statusline_remove(&mut theirs));
        assert_eq!(theirs.pointer("/statusLine/command").unwrap(), "starship prompt");
    }

    #[test]
    fn a_stale_block_is_recognised_and_refreshed() {
        let mut settings = json!({});
        install(&mut settings, EXE);
        assert!(installed(&settings) && current(&settings, EXE));
        // Simulate a block written by an older version: our mark, a different command.
        for event in EVENTS {
            let entries = settings.pointer_mut(&format!("/hooks/{event}")).unwrap().as_array_mut().unwrap();
            entries[0]["hooks"][0]["command"] = json!(format!("old-command ; : {MARK}"));
        }
        assert!(installed(&settings), "it still carries our mark");
        assert!(!current(&settings, EXE), "but it is not the command we ship now");
        install(&mut settings, EXE);
        assert!(current(&settings, EXE), "installing again refreshes it");
    }

    #[test]
    fn install_copes_with_an_empty_or_missing_file() {
        let mut settings = json!({});
        assert!(!installed(&settings));
        install(&mut settings, EXE);
        assert!(installed(&settings));
        assert!(settings.pointer("/hooks/PermissionRequest/0/hooks/0/timeout").unwrap() == 55);
    }
}
