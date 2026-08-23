//! What each Claude Code session is actually doing, from Claude Code's own hooks — not from
//! guessing at output. The session host carries a tiny HTTP listener on loopback; a hook
//! command installed into ~/.claude/settings.json POSTs every event here with the pane's id
//! from its environment. Nothing is parsed out of the terminal stream.
//!
//! The three timing rules are NodeTerm's hard-won ones, reproduced from their design notes
//! (ideas, not code): a `Stop` within 3s of tool activity can be beaten by a late PostToolUse,
//! so "done" holds off; a lost Stop must decay (20 min); Esc fires no hook, so input settles
//! for 1.5s before "working" flips on its own.

use serde::Serialize;

/// One agent state change, forwarded to the window as an event.
#[derive(Serialize, Clone, Debug)]
pub struct AgentEvent {
    /// The pane the hook came from (OBPTERM_PANE_ID in the session's environment).
    pub pane: u32,
    /// working | done | waiting | blocked | reset
    pub state: String,
    /// Claude's session id, present on every hook payload.
    pub session_id: Option<String>,
    /// What the agent last said (Stop), or what it is doing (PreToolUse), or the permission
    /// request's own words.
    pub detail: Option<String>,
    /// For a blocked state: the id the answer file must be named after.
    pub pending_id: Option<String>,
    /// The options of an AskUserQuestion, when that is what blocked it.
    pub options: Vec<String>,
}

/// Maps one hook payload to an event. Pure, so it is testable without HTTP or hooks.
pub fn normalize(pane: u32, payload: &serde_json::Value) -> Option<AgentEvent> {
    let event = payload.get("hook_event_name")?.as_str()?;
    let session_id = payload.get("session_id").and_then(|v| v.as_str()).map(str::to_string);
    let mk = |state: &str, detail: Option<String>| AgentEvent {
        pane,
        state: state.into(),
        session_id: session_id.clone(),
        detail,
        pending_id: None,
        options: Vec::new(),
    };
    Some(match event {
        "UserPromptSubmit" => mk("working", None),
        "PreToolUse" | "PostToolUse" => mk("working", tool_activity(payload)),
        "Stop" | "SubagentStop" | "StopFailure" => mk("done", last_message(payload)),
        "PermissionRequest" => {
            let mut e = mk("blocked", permission_detail(payload));
            e.pending_id = payload.get("obpterm_pending").and_then(|v| v.as_str()).map(str::to_string);
            e.options = question_options(payload);
            e
        }
        "Notification" => {
            let kind = payload.get("notification_type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "permission_prompt" => mk("blocked", payload.get("message").and_then(|v| v.as_str()).map(str::to_string)),
                "elicitation_dialog" | "agent_needs_input" => mk("waiting", payload.get("message").and_then(|v| v.as_str()).map(str::to_string)),
                // idle_prompt also fires after a normal Stop and during a permission prompt:
                // it may only rescue a session still marked working, which the reducer handles.
                "idle_prompt" => mk("idle_rescue", None),
                _ => return None,
            }
        }
        "SessionStart" => mk("reset", None),
        "SessionEnd" => mk("ended", None),
        _ => return None,
    })
}

/// "Editing foo.rs", "Running cargo check…" — from the tool call, clipped for a rail row.
fn tool_activity(payload: &serde_json::Value) -> Option<String> {
    let tool = payload.get("tool_name")?.as_str()?;
    let input = payload.get("tool_input");
    let clip = |s: &str| {
        let s = s.trim();
        if s.len() > 60 { format!("{}…", &s[..s.char_indices().take(59).last().map_or(0, |(i, c)| i + c.len_utf8())]) } else { s.to_string() }
    };
    let path_tail = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str()).map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p).to_string())
    };
    Some(match tool {
        "Edit" | "Write" | "NotebookEdit" => format!("Editing {}", path_tail(input.and_then(|i| i.get("file_path"))).unwrap_or_default()),
        "Read" => format!("Reading {}", path_tail(input.and_then(|i| i.get("file_path"))).unwrap_or_default()),
        "Bash" => format!("Running {}", clip(input.and_then(|i| i.get("command")).and_then(|v| v.as_str()).unwrap_or(""))),
        "Grep" | "Glob" => "Searching".into(),
        "WebFetch" | "WebSearch" => "Fetching".into(),
        "Task" | "Agent" => "Delegating".into(),
        other => other.to_string(),
    })
}

fn last_message(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("last_assistant_message")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(180).collect())
}

fn permission_detail(payload: &serde_json::Value) -> Option<String> {
    tool_activity(payload).or_else(|| payload.get("message").and_then(|v| v.as_str()).map(str::to_string))
}

/// AskUserQuestion's choices, so a notification can carry them.
fn question_options(payload: &serde_json::Value) -> Vec<String> {
    payload
        .pointer("/tool_input/questions/0/options")
        .and_then(|v| v.as_array())
        .map(|opts| {
            opts.iter()
                .filter_map(|o| o.get("label").and_then(|l| l.as_str()))
                .take(4)
                .map(|l| l.chars().take(60).collect())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::normalize;
    use serde_json::json;

    #[test]
    fn the_events_that_matter_map_to_the_right_states() {
        let e = normalize(7, &json!({"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Edit", "tool_input": {"file_path": "C:\\x\\pty.rs"}})).unwrap();
        assert_eq!((e.state.as_str(), e.detail.as_deref()), ("working", Some("Editing pty.rs")));

        let e = normalize(7, &json!({"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": "All done, tests pass."})).unwrap();
        assert_eq!((e.state.as_str(), e.detail.as_deref()), ("done", Some("All done, tests pass.")));

        let e = normalize(7, &json!({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "rm -rf build"}, "obpterm_pending": "p-1"})).unwrap();
        assert_eq!(e.state, "blocked");
        assert_eq!(e.detail.as_deref(), Some("Running rm -rf build"));
        assert_eq!(e.pending_id.as_deref(), Some("p-1"));

        let e = normalize(7, &json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"})).unwrap();
        assert_eq!(e.state, "idle_rescue", "idle_prompt may only rescue a stuck working state");

        let e = normalize(7, &json!({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"options": [{"label": "Yes"}, {"label": "No"}]}]}})).unwrap();
        assert_eq!(e.options, vec!["Yes", "No"]);

        assert!(normalize(7, &json!({"hook_event_name": "SomethingNew"})).is_none());
        assert!(normalize(7, &json!({"no_event": true})).is_none());
    }
}
