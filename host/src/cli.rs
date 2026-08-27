//! The two things Claude Code runs on our behalf, per event, per session.
//!
//! Both used to be shell one-liners. That is cheap on Linux and expensive on Windows, where a
//! process is a heavyweight object: the statusLine was `sh` plus `cat` plus four `printf`s plus
//! three `sed`s — eight processes for one line of text, up to three times a second, per session
//! — and the hook was `sh` plus `curl` for every PreToolUse and PostToolUse of every agent. A
//! ten-agent fan-out is a few hundred process creations in a burst, and the machine feels it.
//!
//! So the host binary does both jobs itself: one process, no shell, no `curl`.

use std::collections::HashMap;
use std::io::{Read, Write};

/// `obpterm-host statusline`: Claude Code pipes its status payload in and prints what we return.
/// The payload is also the only place its own context-window and rate-limit numbers appear, so
/// it is saved for the window to read.
pub fn statusline() {
    let mut payload = String::new();
    if std::io::stdin().read_to_string(&mut payload).is_err() {
        return;
    }
    let dir = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.claude")))
        .or_else(|| std::env::var("USERPROFILE").ok().map(|h| format!("{h}/.claude")));
    if let Some(dir) = dir {
        let _ = std::fs::write(std::path::Path::new(&dir).join("limits.json"), &payload);
    }
    let line = serde_json::from_str::<serde_json::Value>(&payload)
        .map(|v| format_status(&v))
        .unwrap_or_default();
    let _ = std::io::stdout().write_all(line.as_bytes());
}

/// The status line itself: `Opus 5 5h 3% wk 64%`. Percentages are rounded; a window Claude Code
/// did not report reads as 0, which is what the shell version did with a failed `sed`.
pub fn format_status(v: &serde_json::Value) -> String {
    let limits = v.get("rate_limits").unwrap_or(v);
    let pct = |keys: &[&str]| -> u64 {
        keys.iter()
            .find_map(|k| limits.pointer(&format!("/{k}/used_percentage")))
            .and_then(|p| p.as_f64())
            .map(|p| p.round().clamp(0.0, 100.0) as u64)
            .unwrap_or(0)
    };
    let model = v
        .pointer("/model/display_name")
        .and_then(|m| m.as_str())
        .or_else(|| v.get("display_name").and_then(|m| m.as_str()))
        .unwrap_or("");
    format!("{model} 5h {}% wk {}%", pct(&["five_hour"]), pct(&["seven_day", "weekly"]))
}

/// `obpterm-host hook`: forwards Claude Code's hook payload to the running window and prints
/// whatever comes back — the body is how a held permission request is answered, so it has to
/// reach Claude Code's stdout exactly as `curl` used to deliver it.
///
/// Outside OBPTerm none of the environment is set, and the hook is a no-op. That is deliberate:
/// the same settings file is read by every Claude Code on the machine.
pub fn hook() {
    let Ok(pane) = std::env::var("OBPTERM_PANE_ID") else { return };
    if pane.is_empty() {
        return;
    }
    let Ok(env_file) = std::env::var("OBPTERM_HOOK_ENV") else { return };
    let Ok(text) = std::fs::read_to_string(&env_file) else { return };
    let env = parse_env(&text);
    let (Some(port), Some(token)) = (env.get("OBPTERM_HOOK_PORT"), env.get("OBPTERM_HOOK_TOKEN")) else { return };

    let mut body = Vec::new();
    if std::io::stdin().read_to_end(&mut body).is_err() {
        return;
    }
    // Only a permission request can be HELD by the window (see `hooks.rs`): everything else is
    // told, not asked. Waiting for a reply on those is what made `UserPromptSubmit hook timed
    // out after 15s` happen on a machine under memory pressure — the event had already been
    // delivered, and Claude Code sat there for its whole timeout for nothing.
    let decides = decides(&body);
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(0))) else { return };
    // The wait has to outlast the LONGEST hold the listener can impose — the away hold that
    // exists so a phone can answer. A bare 50 here meant this process gave up 130 seconds
    // before the listener did: the tap arrived on a socket nobody was reading. One rule,
    // taken from the one place it is defined, plus a margin.
    let wait = if decides {
        crate::hooks::ANSWER_WAIT_AWAY + std::time::Duration::from_secs(10)
    } else {
        std::time::Duration::from_secs(2)
    };
    let _ = stream.set_read_timeout(Some(wait));
    let head = format!(
        "POST /hook/{token}/{pane} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&body).is_err() {
        return;
    }
    let mut response = Vec::new();
    // A read that times out still returns what arrived; a request nobody can answer just ends.
    let _ = stream.read_to_end(&mut response);
    let _ = std::io::stdout().write_all(http_body(&response));
}

/// Whether this event can be ANSWERED, and so is worth waiting on. Only a permission request is
/// held open by the window (`hooks.rs`); everything else is told, not asked.
pub fn decides(body: &[u8]) -> bool {
    std::str::from_utf8(body).is_ok_and(|b| b.contains("PermissionRequest"))
}

/// `KEY=value` lines, the way the host writes `hook-endpoint.env`.
pub fn parse_env(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// Everything after the blank line. No chunked encoding to handle: the listener always sends a
/// content-length and closes.
pub fn http_body(response: &[u8]) -> &[u8] {
    response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| &response[i + 4..])
        .unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_status_line_reads_the_windows_claude_actually_reports() {
        let payload = json!({
            "model": { "display_name": "Opus 5" },
            "rate_limits": {
                "five_hour": { "used_percentage": 3.4 },
                "seven_day": { "used_percentage": 63.6 },
            },
        });
        assert_eq!(format_status(&payload), "Opus 5 5h 3% wk 64%");
    }

    #[test]
    fn a_window_claude_did_not_report_reads_as_zero() {
        let payload = json!({ "model": { "display_name": "Sonnet 5" }, "rate_limits": { "five_hour": { "used_percentage": 12 } } });
        assert_eq!(format_status(&payload), "Sonnet 5 5h 12% wk 0%");
    }

    #[test]
    fn the_weekly_window_is_also_read_under_its_other_name() {
        let payload = json!({ "rate_limits": { "weekly": { "used_percentage": 50 } } });
        assert_eq!(format_status(&payload), " 5h 0% wk 50%");
    }

    #[test]
    fn the_endpoint_file_parses_the_way_the_shell_read_it() {
        let env = parse_env("OBPTERM_HOOK_PORT=51234\nOBPTERM_HOOK_TOKEN=abc123\n");
        assert_eq!(env.get("OBPTERM_HOOK_PORT").map(String::as_str), Some("51234"));
        assert_eq!(env.get("OBPTERM_HOOK_TOKEN").map(String::as_str), Some("abc123"));
    }

    #[test]
    fn only_a_permission_request_is_worth_waiting_for() {
        // Waiting on the rest is what produced "UserPromptSubmit hook timed out after 15s":
        // the event had already been delivered and Claude Code sat there for nothing.
        assert!(decides(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#));
        for told in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"] {
            assert!(!decides(format!(r#"{{"hook_event_name":"{told}"}}"#).as_bytes()), "{told} is told, not asked");
        }
    }

    #[test]
    fn the_permission_decision_survives_the_trip_to_stdout() {
        let body = r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}"#;
        let response = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        assert_eq!(http_body(response.as_bytes()), body.as_bytes());
    }
}
