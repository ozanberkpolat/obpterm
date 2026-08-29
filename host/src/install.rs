//! Installing the Claude Code hooks: a marked, removable block merged into a settings.json.
//! Pure functions over JSON, so the merge is tested without touching anyone's real config.

use serde_json::{json, Value};

/// Every event the supervision states are derived from.
///
/// `UserPromptSubmit` is deliberately NOT here. It fired the instant you pressed Enter — the one
/// moment you are certainly looking at the pane — and all it bought was the "working" state a
/// second before `PreToolUse` set it anyway. When the hook endpoint is unreachable, Claude Code
/// prints the failure into the prompt, so the cheapest event to lose was also the loudest one.
pub const EVENTS: [&str; 8] = [
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "Notification",
    "PermissionRequest",
    "SessionEnd",
];

/// The sentinel that marks our entries. Bump the suffix when the hook's shape changes, and old
/// entries are replaced instead of duplicated.
///
/// v4 dropped `UserPromptSubmit`. The bump is what makes that take effect: `installed()` and
/// `current()` only ever look at the events in `EVENTS`, so a block written by v3 would still
/// answer "yes, installed and current" while its `UserPromptSubmit` entry sat there firing
/// forever. A changed mark makes `current()` false, and `install()` — which calls `remove()`
/// across every event, not just ours — clears it out.
pub const MARK: &str = "# obpterm-hooks v4";

/// What makes a block OURS, whatever version wrote it. `MARK` carries a version so a stale
/// block can be recognised as stale — but recognition has to ignore that version, or the day
/// the suffix is bumped every older block becomes a stranger: `install` would leave it in place
/// and add a second one beside it, and every hook event would fire twice, through both.
pub const MARK_BASE: &str = "# obpterm-hooks";

/// How the shell should spell the host's path. Only the statusLine still runs through a shell
/// (there is no http statusLine) — on Windows (Git Bash) a backslash is an escape, so forward
/// slashes, always.
fn shell_path(exe: &str) -> String {
    exe.replace('\\', "/")
}

/// Where the hooks POST: one fixed path, since the pane travels as a header (see `hook_object`).
pub fn hook_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/hook")
}

/// The hook itself: an `http` hook, not a `command` one. v2 and earlier ran `sh` + our own
/// binary per event — two process creations for every PreToolUse and PostToolUse of every
/// agent, which is what made a fan-out cost so much on Windows (see `host/src/cli.rs`, kept for
/// the sessions still running an old snapshot). An http hook is Claude Code's own process
/// POSTing on loopback: zero spawns, at any fan-out size.
///
/// The pane id can't live in the URL — the URL is one static string in `settings.json` and
/// cannot vary per pane — so it travels as a header instead, interpolated from the invoking
/// shell's own `$OBPTERM_PANE_ID` (the same variable the old command hook read from its
/// environment). A plain terminal outside any OBPTerm pane has no such variable: the header
/// resolves empty, and the listener drops the request unanswered rather than treating it as a
/// malformed one (see `hooks::parse_pane`) — replacing the `[ -n ... ]` shell guard that used to
/// stop those sessions from even spawning us.
fn hook_object(port: u16, token: &str, timeout: u64) -> Value {
    json!({
        "type": "http",
        "url": hook_url(port),
        "timeout": timeout,
        "headers": {
            "X-OBPTerm-Token": token,
            "X-OBPTerm-Pane": "$OBPTERM_PANE_ID",
            "X-OBPTerm-Mark": MARK,
        },
        "allowedEnvVars": ["OBPTERM_PANE_ID"],
    })
}

/// PermissionRequest's POST is held while the rail decides; give it room. A permission request
/// may be held for `ANSWER_WAIT_AWAY` (3 min) while nobody is looking at the window; the hook's
/// own timeout has to outlast that or Claude Code kills the wait before the answer can arrive
/// from the rail — or from a phone.
fn timeout_for(event: &str) -> u64 {
    if event == "PermissionRequest" { 200 } else { 10 }
}

/// The full `/hooks/<event>` array entry this event should carry.
fn wanted_entry(event: &str, port: u16, token: &str) -> Value {
    let mut entry = json!({ "hooks": [hook_object(port, token, timeout_for(event))] });
    // PostToolUse only ever does one thing: link an Agent-tool call's id to the agent it
    // spawned (`normalize`'s `is_task` branch). Every other tool's PostToolUse is a repeat of
    // the PreToolUse event nobody read differently — and during a fan-out it is half of every
    // hook event fired. Matches both spellings `is_task` accepts: Claude Code has used "Task"
    // and now "Agent" for the same tool across versions.
    if event == "PostToolUse" {
        entry["matcher"] = json!("Task|Agent");
    }
    entry
}

/// Whether one hook object (of any shape, any version) is ours: a v1/v2 `command` carried the
/// mark in a shell comment, a v3 `http` hook carries it in a header.
fn carries_mark(hook: &Value) -> bool {
    hook.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(MARK_BASE))
        || hook.pointer("/headers/X-OBPTerm-Mark").and_then(|c| c.as_str()).is_some_and(|c| c.contains(MARK_BASE))
}

/// True when the settings already carry a block of ours on every event.
pub fn installed(settings: &Value) -> bool {
    EVENTS.iter().all(|event| {
        settings
            .pointer(&format!("/hooks/{event}"))
            .and_then(|v| v.as_array())
            .is_some_and(|entries| {
                entries.iter().any(|e| e.get("hooks").and_then(|h| h.as_array()).is_some_and(|hooks| hooks.iter().any(carries_mark)))
            })
    })
}

/// True when our installed block is the CURRENT shape and address, not a stale one. A settings
/// file written by an earlier version — or by this host's own PREVIOUS run, before a port
/// changed — carries the same mark but a different hook; without this the installer would skip
/// it forever and the app would wait on events that never come.
pub fn current(settings: &Value, port: u16, token: &str) -> bool {
    EVENTS.iter().all(|event| {
        let want = hook_object(port, token, timeout_for(event));
        settings
            .pointer(&format!("/hooks/{event}"))
            .and_then(|v| v.as_array())
            .is_some_and(|entries| entries.iter().any(|e| e.get("hooks").and_then(|h| h.as_array()).is_some_and(|hooks| hooks.contains(&want))))
    })
}

/// Adds (or refreshes) the block, leaving every other hook exactly as it was.
pub fn install(settings: &mut Value, port: u16, token: &str) {
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
        entries.as_array_mut().unwrap().push(wanted_entry(event, port, token));
    }
}

/// Strips every entry of ours, and only ours, from every event.
pub fn remove(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else { return };
    for (_, entries) in hooks.iter_mut() {
        if let Some(list) = entries.as_array_mut() {
            for entry in list.iter_mut() {
                if let Some(inner) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    inner.retain(|h| !carries_mark(h));
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

/// The same problem, and the worse half of it: a statusLine we do not recognise is treated as
/// the user's own and never touched. Bumping the suffix without this made every machine that
/// had ever run an older version keep its old statusLine for good.
pub const SL_MARK_BASE: &str = "# obpterm-statusline";

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
        .is_some_and(|c| c.contains(SL_MARK_BASE))
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

/// Claude Code's Remote Control activates itself for every new session, and `/remote-control`
/// only turns it off for the session you are in — so an app update, which restarts sessions,
/// brings it back every time. `remoteControlAtStartup: false` is the documented switch: it
/// stops the auto-connect and leaves the command available when you do want it.
///
/// Returns whether it wrote. Only ever writes the value the user asked for; turning the switch
/// off REMOVES the key rather than writing `true`, so this never becomes an opinion the app
/// keeps having after being told to stop.
pub fn remote_control_set(settings: &mut Value, disable_at_startup: bool) -> bool {
    if !settings.is_object() {
        *settings = json!({});
    }
    let object = settings.as_object_mut().unwrap();
    let current = object.get(REMOTE_KEY);
    if disable_at_startup {
        if current == Some(&json!(false)) {
            return false;
        }
        object.insert(REMOTE_KEY.into(), json!(false));
        return true;
    }
    // Ours to remove only while it still says what we set it to.
    if current == Some(&json!(false)) {
        object.remove(REMOTE_KEY);
        return true;
    }
    false
}

const REMOTE_KEY: &str = "remoteControlAtStartup";

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

    /// Where the host would live on a real machine; the statusLine command embeds it.
    const EXE: &str = "C:/Users/obp/AppData/Local/OBPTerm/host/obpterm-host-9.9.9.exe";
    const PORT: u16 = 54321;
    const TOKEN: &str = "tok-abc123";

    #[test]
    fn a_v1_command_block_is_upgraded_to_the_http_shape_not_doubled() {
        // The v1 shape, mark and all, as 0.21.12 and earlier wrote it — a `command` hook, not
        // the `http` one this version ships.
        let old = "[ -n \"$OBPTERM_PANE_ID\" ] && curl -s --data-binary @- http://x; : # obpterm-hooks v1".to_string();
        let mut hooks = serde_json::Map::new();
        for event in EVENTS {
            hooks.insert(event.to_string(), json!([{ "hooks": [{ "type": "command", "command": old }] }]));
        }
        let mut settings = json!({
            "hooks": hooks,
            "statusLine": { "type": "command", "command": "p=$(cat); printf '%s' \"$p\"; : # obpterm-statusline v2" },
        });
        assert!(installed(&settings), "an older block is still recognisably ours");
        assert!(!current(&settings, PORT, TOKEN), "but it is not the shape we ship now");

        install(&mut settings, PORT, TOKEN);
        let entries = settings.pointer("/hooks/PreToolUse").unwrap().as_array().unwrap();
        let hooks: Vec<&Value> = entries.iter().flat_map(|e| e.get("hooks").unwrap().as_array().unwrap()).collect();
        assert_eq!(hooks.len(), 1, "the old block is replaced, not joined: {hooks:?}");
        assert_eq!(hooks[0]["type"], "http");
        assert_eq!(hooks[0]["url"], hook_url(PORT));

        // And the statusLine an older version wrote is ours to replace — not a stranger's.
        assert!(statusline_installed(&settings), "our own older statusLine is recognised");
        assert!(statusline_install(&mut settings, EXE), "so it is upgraded");
        assert_eq!(settings.pointer("/statusLine/command").unwrap(), &json!(statusline_command(EXE)));
    }

    #[test]
    fn the_remote_control_switch_is_written_and_taken_back_cleanly() {
        let mut settings = json!({ "model": "opus" });
        assert!(remote_control_set(&mut settings, true), "it writes the documented key");
        assert_eq!(settings.pointer("/remoteControlAtStartup").unwrap(), &json!(false));
        assert!(!remote_control_set(&mut settings, true), "and does not write it twice");
        assert!(remote_control_set(&mut settings, false), "turning the switch off takes it back");
        assert!(settings.get("remoteControlAtStartup").is_none(), "the key is gone, not set to true");
        assert_eq!(settings.get("model").unwrap(), &json!("opus"), "everything else is untouched");

        // A user who set it themselves keeps it: we only ever remove our own value.
        let mut theirs = json!({ "remoteControlAtStartup": true });
        assert!(!remote_control_set(&mut theirs, false));
        assert_eq!(theirs.pointer("/remoteControlAtStartup").unwrap(), &json!(true));
    }

    #[test]
    fn the_hook_spawns_no_process_at_all() {
        // The whole point of this version: zero process creations per event, not one, not
        // eight. An http hook has no `command` field for a shell pipeline to hide in.
        let hook = hook_object(PORT, TOKEN, 10);
        assert_eq!(hook["type"], "http", "not a command hook: {hook:?}");
        assert!(hook.get("command").is_none(), "no shell command to spawn: {hook:?}");
        assert_eq!(hook["url"], format!("http://127.0.0.1:{PORT}/hook"));

        // The statusLine has no http equivalent and stays a command — but still one process,
        // no pipeline.
        let cmd = statusline_command(EXE);
        for banned in ["curl", "sed", "printf", "|", "$("] {
            assert!(!cmd.contains(banned), "{banned:?} is back in {cmd:?}");
        }
        assert!(cmd.contains(EXE), "the command calls the host binary: {cmd:?}");
    }

    #[test]
    fn install_is_idempotent_and_leaves_other_hooks_alone() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "ntfy send done" }] }]
            }
        });
        install(&mut settings, PORT, TOKEN);
        install(&mut settings, PORT, TOKEN); // twice: must not duplicate
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
        install(&mut settings, PORT, TOKEN);
        assert!(installed(&settings) && current(&settings, PORT, TOKEN));
        // Simulate a block written by an older version: our mark, a different token.
        for event in EVENTS {
            let entries = settings.pointer_mut(&format!("/hooks/{event}")).unwrap().as_array_mut().unwrap();
            entries[0]["hooks"][0]["headers"]["X-OBPTerm-Token"] = json!("stale-token");
        }
        assert!(installed(&settings), "it still carries our mark");
        assert!(!current(&settings, PORT, TOKEN), "but it is not the address we ship now");
        install(&mut settings, PORT, TOKEN);
        assert!(current(&settings, PORT, TOKEN), "installing again refreshes it");
    }

    #[test]
    fn a_host_restart_on_a_new_port_is_recognised_as_stale_too() {
        // The exact scenario `hooks::HookAddr` persistence exists to avoid: without it, EVERY
        // host restart would land here, and a session that had already snapshotted the old URL
        // would silently stop reaching us until it too was restarted.
        let mut settings = json!({});
        install(&mut settings, PORT, TOKEN);
        assert!(current(&settings, PORT, TOKEN));
        assert!(!current(&settings, PORT + 1, TOKEN), "a different port is a different address");
        install(&mut settings, PORT + 1, TOKEN);
        assert!(current(&settings, PORT + 1, TOKEN));
    }

    #[test]
    fn an_event_we_stopped_using_is_cleared_out_of_a_block_we_wrote_before() {
        // The v3 shape: ours, current-looking, and carrying a UserPromptSubmit entry. Without
        // the mark bump this block reads as installed AND current, install() never runs, and
        // that entry keeps firing (and keeps printing errors) for the life of the machine.
        let mut settings = json!({});
        install(&mut settings, PORT, TOKEN);
        let ours = settings.pointer("/hooks/Stop/0").unwrap().clone();
        settings["hooks"]["UserPromptSubmit"] = json!([ours]);
        for event in EVENTS {
            let e = settings.pointer_mut(&format!("/hooks/{event}/0/hooks/0/headers/X-OBPTerm-Mark")).unwrap();
            *e = json!("# obpterm-hooks v3");
        }
        settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["headers"]["X-OBPTerm-Mark"] = json!("# obpterm-hooks v3");

        assert!(installed(&settings), "a v3 block is still recognisably ours");
        assert!(!current(&settings, PORT, TOKEN), "but not the shape we ship now");
        install(&mut settings, PORT, TOKEN);

        let left = settings.pointer("/hooks/UserPromptSubmit").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        assert_eq!(left, 0, "the entry for an event we no longer use is gone: {settings:?}");
        assert!(current(&settings, PORT, TOKEN));
    }

    #[test]
    fn post_tool_use_is_scoped_to_the_agent_tool_and_nothing_else_is() {
        // The point of this entry: half the hook events in a fan-out, without losing the one
        // thing PostToolUse is actually for (linking a Task/Agent call's id to its agent).
        let mut settings = json!({});
        install(&mut settings, PORT, TOKEN);
        assert_eq!(settings.pointer("/hooks/PostToolUse/0/matcher").unwrap(), "Task|Agent");
        for event in EVENTS {
            if event == "PostToolUse" {
                continue;
            }
            assert!(settings.pointer(&format!("/hooks/{event}/0/matcher")).is_none(), "{event} must fire on every tool");
        }
    }

    #[test]
    fn install_copes_with_an_empty_or_missing_file() {
        let mut settings = json!({});
        assert!(!installed(&settings));
        install(&mut settings, PORT, TOKEN);
        assert!(installed(&settings));
        assert!(settings.pointer("/hooks/PermissionRequest/0/hooks/0/timeout").unwrap() == 200);
    }
}
