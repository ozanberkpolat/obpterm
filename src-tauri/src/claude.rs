//! Reads Claude Code's own files under a config dir (`~/.claude`, or whatever `CLAUDE_CONFIG_DIR`
//! points at): who is logged in, and how many tokens that account has spent lately.
//!
//! Nothing here talks to the network and nothing here writes: obpterm never holds a token and
//! never touches the credential files. Switching accounts means launching a shell with
//! `CLAUDE_CONFIG_DIR` set, which is why an account in obpterm is just an env preset.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Account {
    pub dir: String,
    /// The name under `accounts/`, when Claude Code is holding several logins.
    pub name: Option<String>,
    pub email: Option<String>,
    pub organization: Option<String>,
    /// e.g. "default_claude_max_5x" — the plan, not a live quota.
    pub tier: Option<String>,
    pub exists: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Bucket {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub messages: u64,
    /// Total tokens billed against the plan: everything except cache reads.
    pub billed: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Usage {
    pub dir: String,
    pub window_5h: Bucket,
    pub window_7d: Bucket,
    /// Newest message seen, epoch ms.
    pub last_activity: Option<i64>,
    pub files_scanned: usize,
    /// 7-day billed tokens per project (display name, tokens), biggest first, top 8.
    pub by_project: Vec<(String, u64)>,
}

/// Where each transcript was last read to, so a refresh only parses what was appended.
#[derive(Default)]
pub struct UsageCache(Mutex<HashMap<PathBuf, FileState>>);

#[derive(Default, Clone)]
struct FileState {
    offset: u64,
    len: u64,
    /// (epoch_ms, billed, input, output, cache_read, cache_write) per message, newest last.
    entries: Vec<(i64, u64, u64, u64, u64, u64)>,
    seen: HashSet<String>,
}

#[tauri::command]
pub fn claude_account(dir: String) -> Account {
    let root = PathBuf::from(expand(&dir));
    let mut account = Account { dir: dir.clone(), exists: root.exists(), ..Default::default() };
    if !account.exists {
        return account;
    }
    let name = std::fs::read_to_string(root.join("accounts").join("current"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Newer Claude Code keeps one dir per login; older versions only have .claude.json.
    let profile = name
        .as_ref()
        .and_then(|n| read_json(&root.join("accounts").join(n).join("account.json")))
        .or_else(|| read_json(&root.join(".claude.json")));
    account.name = name;
    if let Some(v) = profile {
        let o = v.get("oauthAccount").unwrap_or(&v);
        account.email = string_at(o, "emailAddress");
        account.organization = string_at(o, "organizationName");
        account.tier = string_at(o, "organizationRateLimitTier").or_else(|| string_at(o, "userRateLimitTier"));
    }
    account
}

/// Lists the logins Claude Code has stored under this config dir.
#[tauri::command]
pub fn claude_account_names(dir: String) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(PathBuf::from(expand(&dir)).join("accounts"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("account.json").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// Token spend in the last 5 hours and 7 days, summed from the transcripts on disk.
/// This is what *this machine* sent, not Anthropic's own accounting of the plan limit.
/// Async so the sweep runs off the webview's IPC thread: `~/.claude/projects` grows without
/// bound for someone running many sessions, and this is called on every window focus.
#[tauri::command]
pub async fn claude_usage(cache: State<'_, UsageCache>, dir: String) -> Result<Usage, String> {
    let now = now_ms();
    let projects = PathBuf::from(expand(&dir)).join("projects");
    let mut usage = Usage { dir, ..Default::default() };
    let cutoff_7d = now - 7 * 24 * 3_600_000;
    let mut states = cache.0.lock().unwrap();
    let mut per_project: HashMap<String, u64> = HashMap::new();

    for path in transcripts(&projects) {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        // A file untouched since the window opened cannot contribute to it.
        let touched = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(now);
        if touched < cutoff_7d {
            states.remove(&path);
            continue;
        }
        let state = states.entry(path.clone()).or_default();
        if meta.len() < state.len {
            *state = FileState::default(); // truncated or rewritten: start over
        }
        if meta.len() > state.offset {
            scan(&path, state);
        }
        state.len = meta.len();
        state.entries.retain(|e| e.0 >= cutoff_7d);
        usage.files_scanned += 1;
        // The encoded project dir name ("C--Users-obp-repos-obpterm") reads fine by its tail.
        let project = path
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .map(|n| n.rsplit('-').find(|s| !s.is_empty()).unwrap_or(n).to_string())
            .unwrap_or_else(|| "?".into());
        for &(ts, billed, input, output, cache_read, cache_write) in &state.entries {
            *per_project.entry(project.clone()).or_default() += billed;
            add(&mut usage.window_7d, billed, input, output, cache_read, cache_write);
            if ts >= now - 5 * 3_600_000 {
                add(&mut usage.window_5h, billed, input, output, cache_read, cache_write);
            }
            usage.last_activity = Some(usage.last_activity.unwrap_or(ts).max(ts));
        }
    }
    let mut by_project: Vec<(String, u64)> = per_project.into_iter().filter(|(_, b)| *b > 0).collect();
    by_project.sort_by(|a, b| b.1.cmp(&a.1));
    by_project.truncate(8);
    usage.by_project = by_project;
    Ok(usage)
}

fn add(b: &mut Bucket, billed: u64, input: u64, output: u64, cache_read: u64, cache_write: u64) {
    b.billed += billed;
    b.input += input;
    b.output += output;
    b.cache_read += cache_read;
    b.cache_write += cache_write;
    b.messages += 1;
}

fn transcripts(projects: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects) else { return out };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

/// Reads the lines appended since last time, keeping one entry per API message id
/// (a transcript can carry the same assistant message more than once).
fn scan(path: &Path, state: &mut FileState) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut reader = BufReader::new(file);
    if state.offset > 0 && reader.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }
    let mut consumed = state.offset;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                // A partially written last line is left for the next pass.
                if !line.ends_with('\n') {
                    break;
                }
                consumed += n as u64;
                if let Some(entry) = parse_line(&line, &mut state.seen) {
                    state.entries.push(entry);
                }
            }
            Err(_) => break,
        }
    }
    state.offset = consumed;
}

fn parse_line(line: &str, seen: &mut HashSet<String>) -> Option<(i64, u64, u64, u64, u64, u64)> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let message = v.get("message")?;
    let usage = message.get("usage")?;
    let id = message
        .get("id")
        .and_then(|i| i.as_str())
        .map(str::to_string)
        .or_else(|| v.get("uuid").and_then(|i| i.as_str()).map(str::to_string))?;
    if !seen.insert(id) {
        return None;
    }
    let ts = parse_rfc3339_ms(v.get("timestamp")?.as_str()?)?;
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let (input, output, cache_read, cache_write) = (
        n("input_tokens"),
        n("output_tokens"),
        n("cache_read_input_tokens"),
        n("cache_creation_input_tokens"),
    );
    // Cache reads are the cheap part and are not what a plan window is spent on.
    Some((ts, input + output + cache_write, input, output, cache_read, cache_write))
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn string_at(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `2026-08-23T05:41:51.904Z` → epoch ms. Only the shape Claude Code writes: UTC, always `Z`.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if bytes.get(19) == Some(&b'.') { num(20, 23).unwrap_or(0) } else { 0 };
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms)
}

/// Howard Hinnant's civil-from-days, inverted: days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    fn turn(model: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    fn turn_in(model: &str, input: u64) -> String {
        turn(model, input, 0)
    }

    /// The point of the accumulator: a transcript is read once, and what is appended later is
    /// read once more — not the whole megabyte, twenty times a minute, per session.
    #[tokio::test]
    async fn usage_accumulates_and_only_reads_what_was_appended() {
        let root = std::env::temp_dir().join(format!("obpterm-usage-{}", std::process::id()));
        let projects = root.join("projects").join("-home-obp-proj");
        std::fs::create_dir_all(&projects).unwrap();
        let session = format!("s-{}", std::process::id());
        let file = projects.join(format!("{session}.jsonl"));
        std::fs::write(&file, format!("{}\n", turn("claude-opus-5", 1_000_000, 0))).unwrap();

        let prices: Prices = [("opus".to_string(), [15.0, 75.0, 1.5, 18.75])].into_iter().collect();
        let dir = root.display().to_string();
        let usage = |dir: String, session: String, prices: Prices| async move {
            session_stats(dir, vec![session], prices).await.into_iter().next().unwrap().usage.unwrap()
        };
        let first = usage(dir.clone(), session.clone(), prices.clone()).await;
        assert_eq!(first.input, 1_000_000);
        assert_eq!(first.turns, 1);
        assert!((first.cost_usd - 15.0).abs() < 1e-9, "a million input tokens of opus is $15, got {}", first.cost_usd);

        // Append one more turn; the total must move by exactly that turn.
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        use std::io::Write as _;
        writeln!(f, "{}", turn("claude-opus-5", 0, 1_000_000)).unwrap();
        let second = usage(dir.clone(), session.clone(), prices.clone()).await;
        assert_eq!(second.input, 1_000_000, "the first turn is not counted twice");
        assert_eq!(second.output, 1_000_000);
        assert_eq!(second.turns, 2);
        assert!((second.cost_usd - 90.0).abs() < 1e-9, "15 + 75, got {}", second.cost_usd);

        // Nothing appended: same answer, and the offset is already at the end of the file.
        let third = usage(dir.clone(), session.clone(), prices).await;
        assert_eq!(third.turns, 2, "a quiet transcript adds nothing");
        let cached = USAGE_CACHE.lock().unwrap().get(&session).copied().unwrap();
        assert_eq!(cached.0, std::fs::metadata(&file).unwrap().len(), "it reads from the end next time");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// One call, one `limits.json` read, one answer per session — and a session the payload is
    /// not about still gets its context from its own transcript. The old shape read that file
    /// once PER PANE, before its own cache, while the statusLine rewrote it three times a second.
    #[tokio::test]
    async fn one_call_answers_for_every_session_it_was_given() {
        let root = std::env::temp_dir().join(format!("obpterm-stats-{}", std::process::id()));
        let projects = root.join("projects").join("-home-obp-proj");
        std::fs::create_dir_all(&projects).unwrap();
        let mine = format!("mine-{}", std::process::id());
        let other = format!("other-{}", std::process::id());
        for (s, tokens) in [(&mine, 400_000u64), (&other, 100_000)] {
            let body = format!("{}\n{{\"customTitle\":\"named {s}\"}}\n", turn_in("claude-opus-5", tokens));
            std::fs::write(projects.join(format!("{s}.jsonl")), body).unwrap();
        }
        // Claude's own number, for `mine` only.
        std::fs::write(root.join("limits.json"), format!(r#"{{"session_id":"{mine}","context_window":{{"used_percentage":73.4}}}}"#)).unwrap();

        let dir = root.display().to_string();
        let stats = session_stats(dir, vec![mine.clone(), other.clone(), "no-such-session".into()], Prices::new()).await;
        assert_eq!(stats.len(), 3, "one row per session asked for, present or not");

        let m = stats.iter().find(|s| s.session_id == mine).unwrap();
        assert_eq!(m.context_pct, Some(73), "the payload's exact number wins for the session it names");
        assert_eq!(m.title.as_deref(), Some(format!("named {mine}").as_str()));

        let o = stats.iter().find(|s| s.session_id == other).unwrap();
        // 400k of a 1M window for the payload session; `other` falls back to its own transcript.
        assert_eq!(o.context_pct, Some(10), "a session the payload is not about reads its own transcript");
        assert!(o.usage.is_some_and(|u| u.input == 100_000));

        let missing = stats.iter().find(|s| s.session_id == "no-such-session").unwrap();
        assert!(missing.title.is_none() && missing.context_pct.is_none() && missing.usage.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The bug this exists to stop, three times running: a 1M-window session measured against a
    /// guessed 200k reads 250%, clamps to 100%, and the rail states with total confidence that a
    /// half-full conversation is about to be compacted.
    #[tokio::test]
    async fn a_window_we_are_not_sure_of_says_nothing_rather_than_a_confident_100() {
        let root = std::env::temp_dir().join(format!("obpterm-ctx-{}", std::process::id()));
        let projects = root.join("projects").join("-p");
        std::fs::create_dir_all(&projects).unwrap();
        let session = format!("ctx-{}", std::process::id());
        // 500k tokens on a model nothing in the table recognises.
        std::fs::write(projects.join(format!("{session}.jsonl")), format!("{}\n", turn_in("claude-frobnicate-9", 500_000))).unwrap();
        let dir = root.display().to_string();

        let one = session_stats(dir.clone(), vec![session.clone()], Prices::new()).await;
        assert_eq!(one[0].context_pct, None, "an unknown model measures against nothing, so it reports nothing");

        // Now Claude Code's own statusLine reports that model's real window. Every session on
        // that model can be measured from here on — including this one, which is 50%, not 100%.
        std::fs::write(
            root.join("limits.json"),
            r#"{"session_id":"someone-else","model":{"id":"claude-frobnicate-9"},"context_window":{"used_percentage":3,"context_window_size":1000000}}"#,
        )
        .unwrap();
        CONTEXT_CACHE.lock().unwrap().remove(&session);
        let two = session_stats(dir, vec![session.clone()], Prices::new()).await;
        assert_eq!(two[0].context_pct, Some(50), "learned from the payload, not guessed");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_window_table_prefers_what_claude_reported_over_its_own_guess() {
        // A guess that happens to be right is still a guess; a reported size overrides it.
        assert_eq!(window_for("claude-opus-5"), Some(1_000_000), "the substring list still covers what it covers");
        assert_eq!(window_for("claude-haiku-4-5-20251001"), Some(200_000));
        assert_eq!(window_for("claude-something-unreleased"), None, "unknown is None, never a default");
        MODEL_WINDOWS.lock().unwrap().insert("claude-something-unreleased".into(), 400_000);
        assert_eq!(window_for("claude-something-unreleased"), Some(400_000));
        MODEL_WINDOWS.lock().unwrap().remove("claude-something-unreleased");
    }

    #[test]
    fn an_unpriced_model_costs_nothing_rather_than_something_invented() {
        let prices: Prices = [("opus".to_string(), [15.0, 75.0, 1.5, 18.75])].into_iter().collect();
        assert_eq!(price_for(&prices, "claude-opus-5"), [15.0, 75.0, 1.5, 18.75]);
        assert_eq!(price_for(&prices, "some-other-model"), [0.0; 4]);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_weekly_window_is_read_under_both_spellings() {
        // Claude Code's own payload (the shape our statusLine saves verbatim).
        let real = serde_json::json!({"rate_limits": {
            "five_hour": {"used_percentage": 6, "resets_at": 1787678400},
            "seven_day": {"used_percentage": 62, "resets_at": 1788094800}}});
        let dir = std::env::temp_dir().join(format!("obpterm-limits-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("limits.json");
        std::fs::write(&p, real.to_string()).unwrap();
        let got = super::from_statusline_file(p.to_str().unwrap()).unwrap();
        assert_eq!((got.five_hour, got.weekly), (6, 62), "seven_day is the weekly window");
        assert_eq!(got.weekly_resets_at, 1788094800);

        // A file shaped like the homelab endpoint keeps working.
        let ours = serde_json::json!({"five_hour": {"used_percentage": 6}, "weekly": {"used_percentage": 41}});
        std::fs::write(&p, ours.to_string()).unwrap();
        assert_eq!(super::from_statusline_file(p.to_str().unwrap()).unwrap().weekly, 41);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn context_window_follows_the_model() {
        assert_eq!(super::window_for("claude-fable-5"), Some(1_000_000));
        assert_eq!(super::window_for("claude-mythos-5"), Some(1_000_000));
        assert_eq!(super::window_for("claude-sonnet-4-5[1m]"), Some(1_000_000));
        assert_eq!(super::window_for("claude-opus-5"), Some(1_000_000));
        assert_eq!(super::window_for("claude-sonnet-5"), Some(1_000_000));
        assert_eq!(super::window_for("claude-opus-4-1"), Some(200_000));
        // No model, no measurement. This used to answer 200_000, which is how a 1M session
        // whose model we failed to read reported a confident, wrong 100% full.
        assert_eq!(super::window_for(""), None);
    }

    #[test]
    fn pct_reads_floats_and_ints() {
        // The homelab endpoint emits 14.000000000000002; as_u64() returned None and the
        // weekly meter silently showed 0. This pins the fix.
        assert_eq!(super::as_pct(&serde_json::json!(14.000000000000002)), 14);
        assert_eq!(super::as_pct(&serde_json::json!(34)), 34);
        assert_eq!(super::as_pct(&serde_json::json!(99.6)), 100);
        assert_eq!(super::as_pct(&serde_json::json!(250)), 100);
        assert_eq!(super::as_pct(&serde_json::json!("nope")), 0);
    }

    use super::*;

    #[test]
    fn timestamps_convert_to_epoch_ms() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-08-23T05:41:51.904Z"), Some(1_787_463_711_904));
        assert_eq!(parse_rfc3339_ms("2024-02-29T23:59:59Z"), Some(1_709_251_199_000)); // leap day
        assert_eq!(parse_rfc3339_ms("nonsense"), None);
    }

    #[test]
    fn a_repeated_message_is_counted_once_and_cache_reads_are_not_billed() {
        let line = r#"{"timestamp":"2026-08-23T05:41:51.904Z","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":900,"cache_creation_input_tokens":100}}}"#;
        let mut seen = HashSet::new();
        let (ts, billed, input, output, cache_read, cache_write) = parse_line(line, &mut seen).unwrap();
        assert_eq!((billed, input, output, cache_read, cache_write), (115, 10, 5, 900, 100));
        assert!(ts > 0);
        assert!(parse_line(line, &mut seen).is_none(), "the same message id twice is one message");
        assert!(parse_line(r#"{"timestamp":"x","message":{}}"#, &mut seen).is_none());
    }
}

/// Anthropic's own rate-limit numbers — the thing the local token sum can only approximate.
///
/// Claude Code hands `rate_limits` to whatever `statusLine` command is configured, so the
/// percentages and reset times exist even though nothing in `~/.claude` stores them. Two
/// places to find them, both the user's own: a local file written by their statusLine, and an
/// HTTP endpoint on their own machine that already collects it (the homelab's /ssh/ terminal
/// exposes exactly this shape). Nothing is contacted unless one of them is configured.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Limits {
    pub five_hour: u8,
    pub five_hour_resets_at: i64,
    pub weekly: u8,
    pub weekly_resets_at: i64,
    /// "file" or the host it came from, so the status bar can say where the number is from.
    pub source: String,
    /// True when nothing has refreshed it lately: percentages only move while a session runs.
    pub stale: bool,
}

#[tauri::command]
pub async fn claude_limits(file: Option<String>, url: Option<String>) -> Option<Limits> {
    if let Some(path) = file.filter(|p| !p.is_empty()) {
        if let Some(limits) = from_statusline_file(&path) {
            return Some(limits);
        }
    }
    let url = url.filter(|u| !u.is_empty())?;
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = response.json().await.ok()?;
    let host = url.split('/').nth(2).unwrap_or("remote").to_string();
    Some(Limits {
        five_hour: as_pct(body.pointer("/fiveHour/used")?),
        five_hour_resets_at: body.pointer("/fiveHour/resetsAt").and_then(|v| v.as_i64()).unwrap_or(0),
        weekly: body.pointer("/weekly/used").map(as_pct).unwrap_or(0),
        weekly_resets_at: body.pointer("/weekly/resetsAt").and_then(|v| v.as_i64()).unwrap_or(0),
        stale: body.get("stale").and_then(|v| v.as_bool()).unwrap_or(false),
        source: host,
    })
}

/// A used-percentage as whatever JSON number the source emitted: the homelab endpoint sends
/// floats (14.000000000000002), and `as_u64()` on a float is None — which silently zeroed the
/// weekly meter. Round and clamp instead.
fn as_pct(v: &serde_json::Value) -> u8 {
    v.as_f64().unwrap_or(0.0).round().clamp(0.0, 100.0) as u8
}

/// The raw shape Claude Code pipes to a statusLine command, saved to a file by one.
fn from_statusline_file(path: &str) -> Option<Limits> {
    let full = expand(path);
    let text = std::fs::read_to_string(&full).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let rl = v.get("rate_limits").unwrap_or(&v);
    // Claude Code's own payload calls the weekly window `seven_day`; a file shaped like the
    // homelab's claude-state.json calls it `weekly`. Read the first that exists rather than
    // choosing — reading only "weekly" is what pinned the meter at 0% while 5h was right.
    let first = |keys: &[&str], leaf: &str| {
        keys.iter().find_map(|k| rl.pointer(&format!("/{k}/{leaf}")))
    };
    let pct = |keys: &[&str]| first(keys, "used_percentage").map(as_pct).unwrap_or(0);
    let at = |keys: &[&str]| first(keys, "resets_at").and_then(|x| x.as_i64()).unwrap_or(0);
    // `ts` if the writer added one, else the file's own mtime — the sh statusLine has no jq.
    let written = v
        .get("ts")
        .and_then(|t| t.as_f64())
        .map(|t| t as i64)
        .or_else(|| {
            std::fs::metadata(&full)
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
        })
        .unwrap_or(0);
    Some(Limits {
        five_hour: pct(&["five_hour"]),
        five_hour_resets_at: at(&["five_hour"]),
        weekly: pct(&["seven_day", "weekly"]),
        weekly_resets_at: at(&["seven_day", "weekly"]),
        // The file only moves while a session renders its status line.
        stale: written > 0 && now_ms() / 1000 - written > 900,
        source: "file".into(),
    })
}

/// One expander for the whole app — `pty::expand_vars` handles `~` and `%VAR%` both. Having a
/// second, `~`-only copy here is how three commands ended up reading `%USERPROFILE%\.claude-2`
/// as a literal path: the account chip showed logged-out and the meters read zero for exactly
/// the accounts the app's own "Add account" flow creates, while the per-session gauges (which
/// went through the real expander) worked fine.
fn expand(path: &str) -> String {
    crate::pty::expand_vars(path)
}

/// Where a session's transcript lives, remembered. Locating it was a `read_dir(projects)` per
/// call — three calls per pane per tick — and the answer never changes for a session's life.
static PATH_CACHE: std::sync::LazyLock<Mutex<HashMap<String, PathBuf>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn transcript_path(dir: &str, session_id: &str) -> Option<PathBuf> {
    if let Some(p) = PATH_CACHE.lock().ok().and_then(|c| c.get(session_id).cloned()) {
        if p.exists() {
            return Some(p);
        }
    }
    let projects = PathBuf::from(expand(dir)).join("projects");
    let file = std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|d| d.path().join(format!("{session_id}.jsonl")))
        .find(|p| p.exists())?;
    if let Ok(mut c) = PATH_CACHE.lock() {
        c.insert(session_id.to_string(), file.clone());
    }
    Some(file)
}

/// Everything the rail shows about one session, in one call for a list of them. This replaced
/// three IPC round trips per pane every five seconds — at twenty-five tabs, forty to seventy
/// transcript reads per tick, sequentially awaited — with one call the window makes when a
/// session's own hooks say it changed, plus a slow lane. `limits.json` is read ONCE per call:
/// the statusLine rewrites it up to three times a second, and reading it per pane before the
/// cache was the bug that made "a quiet session costs a stat" untrue.
#[derive(Serialize)]
pub struct SessionStats {
    pub session_id: String,
    pub title: Option<String>,
    pub context_pct: Option<u8>,
    pub usage: Option<SessionUsage>,
}

#[tauri::command]
pub async fn session_stats(dir: String, session_ids: Vec<String>, prices: Prices) -> Vec<SessionStats> {
    let payload = payload_context(&dir);
    session_ids
        .into_iter()
        .map(|session_id| {
            let file = transcript_path(&dir, &session_id);
            let Some(file) = file else {
                return SessionStats { session_id, title: None, context_pct: None, usage: None };
            };
            let title = title_of(&session_id, &file);
            let context_pct = match &payload {
                Some((sid, pct)) if *sid == session_id => Some(*pct),
                _ => context_of(&session_id, &file),
            };
            let usage = usage_of(&session_id, &file, &prices);
            SessionStats { session_id, title, context_pct, usage }
        })
        .collect()
}

/// Claude's own name for a session — the `/rename` name if one was given, else the title
/// Claude wrote for itself — from the tail of the session's transcript.
fn title_of(session_id: &str, file: &Path) -> Option<String> {
    // Same discipline as the context gauge: this is asked for EVERY session, not just the one
    // on screen, so a transcript that has not grown must cost a `stat` and nothing more.
    let stamp = std::fs::metadata(file)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
        .unwrap_or((0, None));
    if let Some((seen, title)) = TITLE_CACHE.lock().ok().and_then(|c| c.get(session_id).cloned()) {
        if seen == stamp {
            return title;
        }
    }
    let text = tail(file, 128 * 1024)?;
    let mut ai = None;
    let mut custom = None;
    for line in text.lines() {
        if line.contains("customTitle") {
            if let Some(v) = serde_json::from_str::<serde_json::Value>(line).ok().and_then(|v| v.get("customTitle").and_then(|t| t.as_str()).map(str::to_string)) {
                custom = Some(v);
            }
        } else if line.contains("aiTitle") {
            if let Some(v) = serde_json::from_str::<serde_json::Value>(line).ok().and_then(|v| v.get("aiTitle").and_then(|t| t.as_str()).map(str::to_string)) {
                ai = Some(v);
            }
        }
    }
    let title = custom.or(ai);
    if let Ok(mut c) = TITLE_CACHE.lock() {
        c.insert(session_id.to_string(), (stamp, title.clone()));
    }
    title
}

/// session id -> (what the transcript looked like when we read it, the name it carried).
static TITLE_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (FileStamp, Option<String>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// How full this session's context window is, as a rough percentage: the last usage block's
/// input + cache tokens over the model's window. Enough to warn before an auto-compact — not
/// accounting. None when a usage entry cannot be found. (Claude's own exact number, from the
/// statusLine payload, is preferred by `session_stats` when the payload is this session's.)
fn context_of(session_id: &str, file: &Path) -> Option<u8> {
    // The transcript is re-read for a gauge that only moves when the file grows. Remember the
    // last answer against the file's size and mtime and skip the 256 KB read plus the JSON
    // parse of every usage line when nothing has been appended.
    let stamp = std::fs::metadata(file)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
        .unwrap_or((0, None));
    if let Some((seen, pct)) = CONTEXT_CACHE.lock().ok().and_then(|c| c.get(session_id).copied()) {
        if seen == stamp {
            return pct;
        }
    }
    let text = tail(file, 256 * 1024)?;
    let mut last: Option<u64> = None;
    let mut model = String::new();
    for line in text.lines() {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        // Subagent (sidechain) entries carry the SUBAGENT's context, not this session's.
        if v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(u) = v.pointer("/message/usage") else { continue };
        let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if total > 0 {
            last = Some(total);
            if let Some(m) = v.pointer("/message/model").and_then(|x| x.as_str()) {
                model = m.to_string();
            }
        }
    }
    // A number over 100% does not mean a full window — it means the window we measured against
    // is too small, i.e. we guessed the model wrong. Clamping produced a confident "ctx 100%"
    // on a session that was actually half full. Say nothing instead.
    let pct = last.zip(window_for(&model)).and_then(|(t, w)| {
        let raw = (t as f64 / w as f64) * 100.0;
        (raw <= 105.0).then_some(raw.round().clamp(0.0, 100.0) as u8)
    });
    if let Ok(mut c) = CONTEXT_CACHE.lock() {
        c.insert(session_id.to_string(), (stamp, pct));
    }
    pct
}

/// What one session has spent, from its own transcript. Tokens are counted; the money is an
/// estimate against a price table the user can edit — nothing is fetched from anywhere.
#[derive(Serialize, Clone, Copy, Default, Debug)]
pub struct SessionUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
    /// Assistant turns counted — the denominator behind "cost per turn".
    pub turns: u64,
}

/// Prices in dollars per MILLION tokens, keyed by a substring of the model id (first match wins,
/// longest key first). The window passes its own table down from config.
pub type Prices = HashMap<String, [f64; 4]>;

/// Incremental: transcripts only ever grow, so each call reads the bytes appended since the last
/// one and adds them to what it already knew. A megabyte re-parsed every few seconds, times twenty
/// sessions, is exactly the kind of bookkeeping that costs more than it earns.
static USAGE_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (u64, SessionUsage)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn usage_of(session_id: &str, file: &Path, prices: &Prices) -> Option<SessionUsage> {
    let len = std::fs::metadata(file).ok()?.len();

    let (mut offset, mut total) = USAGE_CACHE
        .lock()
        .ok()
        .and_then(|c| c.get(session_id).copied())
        .unwrap_or((0, SessionUsage::default()));
    // A file that shrank was replaced (a `/clear`, a new session under the same id): start over.
    if len < offset {
        offset = 0;
        total = SessionUsage::default();
    }
    if len > offset {
        if let Some(text) = read_from(file, offset) {
            for line in text.lines() {
                if !line.contains("\"usage\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(u) = v.pointer("/message/usage") else { continue };
                let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let (i, o) = (n("input_tokens"), n("output_tokens"));
                let (cr, cw) = (n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
                if i + o + cr + cw == 0 {
                    continue;
                }
                let model = v.pointer("/message/model").and_then(|x| x.as_str()).unwrap_or("");
                total.input += i;
                total.output += o;
                total.cache_read += cr;
                total.cache_write += cw;
                total.turns += 1;
                let rate = price_for(prices, model);
                total.cost_usd += (i as f64 * rate[0] + o as f64 * rate[1] + cr as f64 * rate[2] + cw as f64 * rate[3]) / 1e6;
            }
        }
        offset = len;
    }
    if let Ok(mut c) = USAGE_CACHE.lock() {
        c.insert(session_id.to_string(), (offset, total));
    }
    Some(total)
}

/// The price row for a model: the longest key that appears in its id, else zeros — an unpriced
/// model shows tokens and no money rather than a number nobody should trust.
fn price_for(prices: &Prices, model: &str) -> [f64; 4] {
    let m = model.to_ascii_lowercase();
    prices
        .iter()
        .filter(|(k, _)| m.contains(&k.to_ascii_lowercase()))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, v)| *v)
        .unwrap_or([0.0; 4])
}

/// The tail of a file from `offset` on.
fn read_from(path: &Path, offset: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    Some(buf)
}

type FileStamp = (u64, Option<std::time::SystemTime>);
/// session id -> (what the transcript looked like when we read it, what it said).
static CONTEXT_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (FileStamp, Option<u8>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// The saved statusLine payload: which session it is about, and Claude's own percentage for
/// it. Read once per `session_stats` call, never per session.
///
/// It also TEACHES us the model's context window on the way past. The payload carries
/// `context_window_size` for the session it describes, so every session whose statusLine has
/// rendered calibrates the transcript-math fallback for every other session on that model —
/// which is the only way to stop guessing (see `window_for`).
fn payload_context(dir: &str) -> Option<(String, u8)> {
    let text = std::fs::read_to_string(PathBuf::from(expand(dir)).join("limits.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    learn_window(&v);
    let sid = v.get("session_id").and_then(|s| s.as_str())?.to_string();
    let pct = v.pointer("/context_window/used_percentage").and_then(|p| p.as_f64()).map(|p| p.round().clamp(0.0, 100.0) as u8)?;
    Some((sid, pct))
}

/// model id -> the window Claude Code itself reported for it.
static MODEL_WINDOWS: std::sync::LazyLock<Mutex<HashMap<String, u64>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn learn_window(payload: &serde_json::Value) {
    let size = ["/context_window/context_window_size", "/context_window/total", "/context_window_size"]
        .iter()
        .find_map(|p| payload.pointer(p).and_then(|v| v.as_u64()))
        .filter(|n| *n > 0);
    let model = ["/model/id", "/model/display_name", "/model"]
        .iter()
        .find_map(|p| payload.pointer(p).and_then(|v| v.as_str()))
        .map(|m| m.to_ascii_lowercase());
    if let (Some(size), Some(model)) = (size, model) {
        if let Ok(mut c) = MODEL_WINDOWS.lock() {
            c.insert(model, size);
        }
    }
}

/// The context window the transcript-math fallback measures against, or None when we do not
/// actually know it. Only sessions the statusLine has not reported on land here at all.
///
/// What Claude Code told us wins: `learn_window` records the real size per model from the
/// statusLine payload. The substring list is the fallback's fallback, and it is a GUESS — it
/// has been wrong twice, both times by assuming 200k for a 1M session, which pins the meter at
/// a confident 100%. So when nothing matches, this returns None and the gauge says nothing
/// rather than something false.
fn window_for(model: &str) -> Option<u64> {
    let m = model.to_ascii_lowercase();
    if let Ok(c) = MODEL_WINDOWS.lock() {
        if let Some(n) = c.get(&m).copied() {
            return Some(n);
        }
        // The payload spells a model differently from the transcript often enough to be worth
        // one containment pass before giving up.
        if let Some((_, n)) = c.iter().find(|(k, _)| m.contains(k.as_str()) || k.contains(&m)) {
            return Some(*n);
        }
    }
    let million = ["fable", "mythos", "[1m]", "-1m", "opus-5", "sonnet-5"];
    if million.iter().any(|p| m.contains(p)) {
        return Some(1_000_000);
    }
    let known_200k = ["opus-4", "sonnet-4", "haiku-4", "haiku-3", "sonnet-3", "opus-3"];
    if known_200k.iter().any(|p| m.contains(p)) {
        return Some(200_000);
    }
    None
}

fn tail(path: &Path, max: u64) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len > max {
        f.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut buf = String::new();
    std::io::Read::read_to_string(&mut f, &mut buf).ok()?;
    Some(buf)
}
