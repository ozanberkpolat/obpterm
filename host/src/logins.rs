//! Switching between Claude Code logins — a port of the homelab's `ops/cc_account.py`, same
//! layout on disk, same refusals, so the laptop and the VPS behave identically.
//!
//! A profile is `<claude dir>/accounts/<name>/{credentials.json, account.json}` plus a `current`
//! marker naming the profile the live login belongs to. A switch saves the live login back into
//! its own slot first (refresh tokens rotate; a snapshot from days ago is dead), then copies the
//! other profile over `.credentials.json` and the two identity keys of `~/.claude.json`. Nothing
//! else is touched: settings, memory, projects and plugins are shared by both logins.
//!
//! Two refusals keep the save-back from landing in the wrong slot, which would destroy the other
//! account's tokens: no `current` marker, or a live email that is not the marked profile's. Both
//! mean "save the live login first". And a switch refuses while `claude` runs — a live session
//! rotates its token and would write it over the file just swapped in, killing both logins.

//! It lives in the host crate only because that crate builds and tests on Linux; the app crate
//! cannot (no GTK here). Nothing in it is host-specific.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The keys of ~/.claude.json that belong to a login, and nothing else.
const KEYS: [&str; 2] = ["oauthAccount", "userID"];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Login {
    pub name: String,
    pub email: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Logins {
    pub accounts: Vec<Login>,
    pub current: Option<String>,
    /// The live login's email, from ~/.claude.json.
    pub email: Option<String>,
    /// Names of running `claude` processes' windows are not known; the count is.
    pub running: usize,
    /// False when there is no `.credentials.json` at all — this Claude Code keeps logins elsewhere.
    pub file_backed: bool,
}

pub struct Paths {
    pub creds: PathBuf,
    pub cfg: PathBuf,
    pub acc_dir: PathBuf,
}

/// `home` is the directory holding `.claude/` and `.claude.json` — the user's profile dir.
pub fn paths(home: &Path) -> Paths {
    Paths {
        creds: home.join(".claude").join(".credentials.json"),
        cfg: home.join(".claude.json"),
        acc_dir: home.join(".claude").join("accounts"),
    }
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 24 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Atomic within the directory, like the script's mkstemp + replace.
fn write_json(p: &Path, v: &serde_json::Value) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("replace {}: {e}", p.display()))
}

fn email_of(v: Option<&serde_json::Value>) -> Option<String> {
    v?.get("oauthAccount")?.get("emailAddress")?.as_str().map(str::to_string)
}

pub fn current(home: &Path) -> Option<String> {
    let n = std::fs::read_to_string(paths(home).acc_dir.join("current")).ok()?.trim().to_string();
    valid_name(&n).then_some(n)
}

fn set_current(home: &Path, name: &str) -> Result<(), String> {
    let dir = paths(home).acc_dir;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("current"), name).map_err(|e| e.to_string())
}

/// Snapshot the live credentials + identity into profile `name`.
pub fn save(home: &Path, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("a profile name is letters, digits, - or _ (max 24)".into());
    }
    let p = paths(home);
    if !p.creds.exists() {
        return Err(format!("no live credentials at {} — log in first", p.creds.display()));
    }
    let dir = p.acc_dir.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&p.creds, dir.join("credentials.json")).map_err(|e| format!("copy credentials: {e}"))?;
    let cfg = read_json(&p.cfg).unwrap_or(serde_json::json!({}));
    let mut acct = serde_json::Map::new();
    for k in KEYS {
        acct.insert(k.to_string(), cfg.get(k).cloned().unwrap_or(serde_json::Value::Null));
    }
    write_json(&dir.join("account.json"), &serde_json::Value::Object(acct))?;
    set_current(home, name)
}

/// Copy profile `name` over the live credentials and the two identity keys; everything else
/// in ~/.claude.json stays exactly as it was.
fn load(home: &Path, name: &str) -> Result<(), String> {
    let p = paths(home);
    let dir = p.acc_dir.join(name);
    let src = dir.join("credentials.json");
    if !src.exists() {
        return Err(format!("no such profile: {name}"));
    }
    if let Some(parent) = p.creds.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &p.creds).map_err(|e| format!("copy credentials: {e}"))?;
    let acct = read_json(&dir.join("account.json")).unwrap_or(serde_json::json!({}));
    if let Some(mut cfg) = read_json(&p.cfg) {
        for k in KEYS {
            if let Some(v) = acct.get(k).filter(|v| !v.is_null()) {
                cfg[k] = v.clone();
            }
        }
        write_json(&p.cfg, &cfg)?;
    }
    set_current(home, name)
}

pub fn listing(home: &Path, running: usize) -> Logins {
    let p = paths(home);
    let mut accounts = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&p.acc_dir) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| valid_name(n))
            .collect();
        names.sort();
        for name in names {
            let email = email_of(read_json(&p.acc_dir.join(&name).join("account.json")).as_ref());
            accounts.push(Login { name, email });
        }
    }
    Logins {
        accounts,
        current: current(home),
        email: email_of(read_json(&p.cfg).as_ref()),
        running,
        file_backed: p.creds.exists(),
    }
}

/// Save the live login back into its own slot, then load profile `name`.
pub fn switch(home: &Path, name: &str, running: usize) -> Result<(), String> {
    if running > 0 {
        return Err(format!(
            "claude is running in {running} place{} — exit it first, then switch",
            if running > 1 { "s" } else { "" }
        ));
    }
    let cur = current(home);
    if cur.as_deref() == Some(name) {
        return Ok(());
    }
    let p = paths(home);
    if p.creds.exists() {
        let Some(cur) = cur else {
            return Err("the live login is not saved to any profile — save it first".into());
        };
        let live = email_of(read_json(&p.cfg).as_ref());
        let slot = email_of(read_json(&p.acc_dir.join(&cur).join("account.json")).as_ref());
        if let (Some(live), Some(slot)) = (&live, &slot) {
            if live != slot {
                return Err(format!("the live login ({live}) is not profile '{cur}' ({slot}) — save it first"));
            }
        }
        save(home, &cur)?;
    }
    load(home, name)
}

pub fn forget(home: &Path, name: &str) -> Result<(), String> {
    let p = paths(home);
    let dir = p.acc_dir.join(name);
    if !dir.is_dir() {
        return Err(format!("no such profile: {name}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    if current(home).as_deref() == Some(name) {
        // The live login stays; it just has no slot now.
        let _ = std::fs::remove_file(p.acc_dir.join("current"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The script's selftest, ported: two fake profiles round-trip in a temp home with no real
    //! credentials anywhere near it.
    use super::*;

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("obpterm-logins-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        dir
    }

    fn rand_suffix() -> String {
        format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
    }

    fn log_in_as(home: &Path, email: &str, token: &str) {
        let p = paths(home);
        std::fs::write(&p.creds, format!(r#"{{"claudeAiOauth":{{"accessToken":"{token}"}}}}"#)).unwrap();
        let cfg = serde_json::json!({
            "oauthAccount": { "emailAddress": email, "organizationName": format!("{email}'s org") },
            "userID": format!("uid-{email}"),
            "numStartups": 42,
            "tipsHistory": { "x": 1 },
        });
        write_json(&p.cfg, &cfg).unwrap();
    }

    fn creds(home: &Path) -> String {
        std::fs::read_to_string(paths(home).creds).unwrap()
    }

    #[test]
    fn save_switch_and_the_unrelated_keys_survive() {
        let home = temp_home();
        log_in_as(&home, "a@example.com", "tok-a");
        save(&home, "a").unwrap();
        log_in_as(&home, "b@example.com", "tok-b");
        save(&home, "b").unwrap();
        assert_eq!(current(&home).as_deref(), Some("b"));

        switch(&home, "a", 0).unwrap();
        assert!(creds(&home).contains("tok-a"), "profile a's credentials are live");
        let cfg = read_json(&paths(&home).cfg).unwrap();
        assert_eq!(cfg["oauthAccount"]["emailAddress"], "a@example.com");
        assert_eq!(cfg["userID"], "uid-a@example.com");
        assert_eq!(cfg["numStartups"], 42, "keys that are not a login are untouched");
        assert_eq!(cfg["tipsHistory"]["x"], 1);

        // Tokens rotate: a switch back must carry the *current* live token into the slot.
        std::fs::write(paths(&home).creds, r#"{"claudeAiOauth":{"accessToken":"tok-a-rotated"}}"#).unwrap();
        switch(&home, "b", 0).unwrap();
        assert!(creds(&home).contains("tok-b"));
        switch(&home, "a", 0).unwrap();
        assert!(creds(&home).contains("tok-a-rotated"), "the save-back kept the rotated token");

        let l = listing(&home, 0);
        assert_eq!(l.accounts.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(l.email.as_deref(), Some("a@example.com"));
        assert!(l.file_backed);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn the_refusals_that_protect_the_other_login() {
        let home = temp_home();
        log_in_as(&home, "a@example.com", "tok-a");
        save(&home, "a").unwrap();
        log_in_as(&home, "b@example.com", "tok-b");
        save(&home, "b").unwrap();

        assert!(switch(&home, "a", 2).unwrap_err().contains("claude is running"), "never while a session can rotate the token");

        // Logged in by hand as someone else while the marker still says b: the save-back would
        // land c's tokens in b's slot.
        log_in_as(&home, "c@example.com", "tok-c");
        let err = switch(&home, "a", 0).unwrap_err();
        assert!(err.contains("save it first"), "{err}");
        assert!(creds(&home).contains("tok-c"), "and nothing was touched");

        // No marker at all: nowhere to save the live login into.
        std::fs::remove_file(paths(&home).acc_dir.join("current")).unwrap();
        assert!(switch(&home, "a", 0).unwrap_err().contains("save it first"));

        assert!(save(&home, "bad name!").is_err());
        forget(&home, "b").unwrap();
        assert!(!paths(&home).acc_dir.join("b").exists());
        std::fs::remove_dir_all(home).unwrap();
    }
}
