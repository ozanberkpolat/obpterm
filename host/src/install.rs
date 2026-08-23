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
pub const MARK: &str = "# obpterm-hooks v1";

/// The command itself: gated on being inside OBPTerm (a plain terminal is a no-op), reading
/// the current port and token from the env file the host rewrites at boot, failing open
/// always. POSIX sh — Claude Code runs hooks through a POSIX shell on Windows (Git Bash).
pub fn hook_command() -> String {
    format!(
        r#"[ -n "$OBPTERM_PANE_ID" ] && [ -f "$OBPTERM_HOOK_ENV" ] && . "$OBPTERM_HOOK_ENV" && curl -s -m 50 --data-binary @- "http://127.0.0.1:$OBPTERM_HOOK_PORT/hook/$OBPTERM_HOOK_TOKEN/$OBPTERM_PANE_ID"; : {MARK}"#
    )
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

/// Adds (or refreshes) the block, leaving every other hook exactly as it was.
pub fn install(settings: &mut Value) {
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
            "hooks": [{ "type": "command", "command": hook_command(), "timeout": timeout }]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_is_idempotent_and_leaves_other_hooks_alone() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "ntfy send done" }] }]
            }
        });
        install(&mut settings);
        install(&mut settings); // twice: must not duplicate
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
    fn install_copes_with_an_empty_or_missing_file() {
        let mut settings = json!({});
        assert!(!installed(&settings));
        install(&mut settings);
        assert!(installed(&settings));
        assert!(settings.pointer("/hooks/PermissionRequest/0/hooks/0/timeout").unwrap() == 55);
    }
}
