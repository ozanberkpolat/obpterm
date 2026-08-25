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
    /// The tool a PermissionRequest is about ("Bash"), so the window can grade and allowlist.
    pub tool: Option<String>,
    /// Its raw input — the full command for Bash — unclipped, unlike `detail`.
    pub tool_input: Option<String>,
    /// Agent lineage: which agent this event is about, when a session fanned out.
    /// `agent_id` is Claude's own tool_use id for the Task call, stable start to stop.
    pub agent_id: Option<String>,
    /// "Explore", "general-purpose" — the subagent_type the Task named.
    pub agent_kind: Option<String>,
    /// The Task's own description: "Audit upstream consumers".
    pub agent_task: Option<String>,
    /// spawned | tool | finished — what just happened to that agent.
    pub agent_event: Option<String>,
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
        tool: None,
        tool_input: None,
        agent_id: None,
        agent_kind: None,
        agent_task: None,
        agent_event: None,
    };
    Some(match event {
        "UserPromptSubmit" => mk("working", None),
        // A Task call IS the fan-out: PreToolUse opens an agent, PostToolUse closes it.
        "PreToolUse" | "PostToolUse" if is_task(payload) => {
            let mut e = mk("working", tool_activity(payload));
            e.agent_id = payload.get("tool_use_id").and_then(|v| v.as_str()).map(str::to_string);
            e.agent_kind = payload.pointer("/tool_input/subagent_type").and_then(|v| v.as_str()).map(str::to_string);
            e.agent_task = payload
                .pointer("/tool_input/description")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(80).collect());
            e.agent_event = Some(if event == "PreToolUse" { "spawned" } else { "finished" }.into());
            e
        }
        "PreToolUse" | "PostToolUse" => {
            let mut e = mk("working", tool_activity(payload));
            // Inside a fan-out, tool calls carry the agent's own id: they are its feed, and
            // must not read as the parent session working.
            if let Some(id) = agent_of(payload) {
                e.agent_id = Some(id);
                e.agent_kind = agent_type_of(payload);
                e.agent_event = Some("tool".into());
            }
            e
        }
        // SubagentStop closes ONE agent; only Stop ends the session's turn. Folding them
        // together used to mark a still-running parent as done.
        "SubagentStop" => {
            let mut e = mk("working", last_message(payload));
            e.agent_id = agent_of(payload);
            e.agent_kind = agent_type_of(payload);
            e.agent_event = Some("finished".into());
            e
        }
        "Stop" | "StopFailure" => mk("done", last_message(payload)),
        "PermissionRequest" => {
            let mut e = mk("blocked", permission_detail(payload));
            e.pending_id = payload.get("obpterm_pending").and_then(|v| v.as_str()).map(str::to_string);
            e.options = question_options(payload);
            e.tool = payload.get("tool_name").and_then(|v| v.as_str()).map(str::to_string);
            e.tool_input = payload
                .pointer("/tool_input/command")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(500).collect());
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

/// True for the Task tool — the call that fans work out to an agent.
fn is_task(payload: &serde_json::Value) -> bool {
    matches!(payload.get("tool_name").and_then(|v| v.as_str()), Some("Task") | Some("Agent"))
}

/// The agent an event belongs to. Verified against real payloads: work done INSIDE a fan-out
/// carries `agent_id` (plus `agent_type`); the parent session's own tool calls carry neither.
/// There is no `isSidechain` flag in hook payloads — an earlier guess at one is why this
/// never fired in practice.
fn agent_of(payload: &serde_json::Value) -> Option<String> {
    payload.get("agent_id").and_then(|v| v.as_str()).map(str::to_string)
}

/// The agent's kind, as the payload spells it on its own events ("general-purpose").
fn agent_type_of(payload: &serde_json::Value) -> Option<String> {
    payload.get("agent_type").and_then(|v| v.as_str()).map(str::to_string)
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
        assert_eq!((e.tool.as_deref(), e.tool_input.as_deref()), (Some("Bash"), Some("rm -rf build")), "the raw command rides along for grading");

        let e = normalize(7, &json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"})).unwrap();
        assert_eq!(e.state, "idle_rescue", "idle_prompt may only rescue a stuck working state");

        let e = normalize(7, &json!({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"options": [{"label": "Yes"}, {"label": "No"}]}]}})).unwrap();
        assert_eq!(e.options, vec!["Yes", "No"]);

        // The shapes below are copied from payloads captured off a LIVE Claude Code session
        // (2026-08-26) — the tool is named "Agent", the fan-out's own work is marked with
        // agent_id + agent_type, and there is no isSidechain flag anywhere.
        let e = normalize(7, &json!({"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_use_id": "t-1",
            "cwd": "/home/obp/iot-stack", "session_id": "s1", "permission_mode": "default", "prompt_id": "p1",
            "tool_input": {"subagent_type": "Explore", "description": "Audit upstream consumers", "model": "haiku", "prompt": "…"}})).unwrap();
        assert_eq!(e.agent_event.as_deref(), Some("spawned"));
        assert_eq!(e.agent_id.as_deref(), Some("t-1"));
        assert_eq!(e.agent_kind.as_deref(), Some("Explore"));
        assert_eq!(e.agent_task.as_deref(), Some("Audit upstream consumers"));

        // …its own tool calls are the agent's feed, not the session's…
        let e = normalize(7, &json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "b-9",
            "agent_id": "t-1", "agent_type": "general-purpose", "tool_input": {"command": "echo hi"}})).unwrap();
        assert_eq!((e.agent_id.as_deref(), e.agent_event.as_deref()), (Some("t-1"), Some("tool")));
        assert_eq!(e.agent_kind.as_deref(), Some("general-purpose"), "the kind rides its own events too");

        // …and SubagentStop closes that agent WITHOUT ending the session's turn.
        let e = normalize(7, &json!({"hook_event_name": "SubagentStop", "agent_id": "t-1",
            "agent_type": "general-purpose", "agent_transcript_path": "/x.jsonl",
            "last_assistant_message": "Output: hook-probe", "stop_hook_active": false})).unwrap();
        assert_eq!(e.state, "working", "one agent finishing must not mark the session done");
        assert_eq!((e.agent_id.as_deref(), e.agent_event.as_deref()), (Some("t-1"), Some("finished")));

        // A plain tool call still belongs to the session itself: no agent_id in its payload.
        let e = normalize(7, &json!({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_use_id": "r-1",
            "tool_input": {"file_path": "/x/y.rs"}})).unwrap();
        assert!(e.agent_id.is_none() && e.agent_event.is_none());

        assert!(normalize(7, &json!({"hook_event_name": "SomethingNew"})).is_none());
        assert!(normalize(7, &json!({"no_event": true})).is_none());
    }
}
