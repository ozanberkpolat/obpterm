//! Reads Claude Code's own files under a config dir (`~/.claude`, or whatever `CLAUDE_CONFIG_DIR`
//! points at): who is logged in, and how many tokens that account has spent lately.
//!
//! Nothing here talks to the network and nothing here writes: winterm never holds a token and
//! never touches the credential files. Switching accounts means launching a shell with
//! `CLAUDE_CONFIG_DIR` set, which is why an account in winterm is just an env preset.

use serde::Serialize;
use std::collections::HashMap;
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
    seen: Vec<String>,
}

#[tauri::command]
pub fn claude_account(dir: String) -> Account {
    let root = PathBuf::from(&dir);
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
    let mut names: Vec<String> = std::fs::read_dir(PathBuf::from(dir).join("accounts"))
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
#[tauri::command]
pub fn claude_usage(cache: State<UsageCache>, dir: String) -> Usage {
    let now = now_ms();
    let projects = PathBuf::from(&dir).join("projects");
    let mut usage = Usage { dir, ..Default::default() };
    let cutoff_7d = now - 7 * 24 * 3_600_000;
    let mut states = cache.0.lock().unwrap();

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
        for &(ts, billed, input, output, cache_read, cache_write) in &state.entries {
            add(&mut usage.window_7d, billed, input, output, cache_read, cache_write);
            if ts >= now - 5 * 3_600_000 {
                add(&mut usage.window_5h, billed, input, output, cache_read, cache_write);
            }
            usage.last_activity = Some(usage.last_activity.unwrap_or(ts).max(ts));
        }
    }
    usage
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

fn parse_line(line: &str, seen: &mut Vec<String>) -> Option<(i64, u64, u64, u64, u64, u64)> {
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
    if seen.contains(&id) {
        return None;
    }
    seen.push(id);
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
mod tests {
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
        let mut seen = Vec::new();
        let (ts, billed, input, output, cache_read, cache_write) = parse_line(line, &mut seen).unwrap();
        assert_eq!((billed, input, output, cache_read, cache_write), (115, 10, 5, 900, 100));
        assert!(ts > 0);
        assert!(parse_line(line, &mut seen).is_none(), "the same message id twice is one message");
        assert!(parse_line(r#"{"timestamp":"x","message":{}}"#, &mut seen).is_none());
    }
}
