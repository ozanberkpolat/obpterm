//! Small commands the Wave-1 review features need: a git diffstat for a directory, an
//! allowlist rule appended to a project's Claude settings, and a pasted image written to a
//! temp file so its path can be typed into a prompt.

use std::path::PathBuf;

fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash per poll
    }
    cmd
}

/// `git diff --shortstat HEAD` for a directory. None when it is not a repo (or git fails) —
/// callers hide the chip rather than showing an error.
#[tauri::command]
pub fn git_shortstat(cwd: String) -> Option<String> {
    let out = quiet(std::process::Command::new("git").args(["-C", &cwd, "diff", "--shortstat", "HEAD"]))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(text) // "" = clean tree; the frontend renders that as ±0
}

/// Appends one rule to `<cwd>/.claude/settings.local.json` `permissions.allow` — the file
/// Claude Code itself reads, so the rule works in every terminal, not just this one.
#[tauri::command]
pub fn allow_rule(cwd: String, rule: String) -> Result<(), String> {
    if rule.is_empty() || rule.len() > 200 {
        return Err("that rule does not look right".into());
    }
    let dir = PathBuf::from(&cwd).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.local.json");
    // Missing = fresh; unparseable = someone's real file, refused rather than overwritten.
    let mut settings: serde_json::Value = match std::fs::read_to_string(&path) {
        Err(_) => serde_json::json!({}),
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} does not parse ({e}) — fix or delete it first", path.display()))?,
    };
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let list = settings
        .as_object_mut()
        .unwrap()
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("permissions is not an object in settings.local.json")?
        .entry("allow")
        .or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        return Err("permissions.allow is not a list in settings.local.json".into());
    }
    let arr = list.as_array_mut().unwrap();
    if !arr.iter().any(|v| v.as_str() == Some(rule.as_str())) {
        arr.push(serde_json::Value::String(rule));
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// A pasted bitmap, written where a prompt can reference it. PNG bytes in, path out.
#[tauri::command]
pub fn save_clip_image(png: Vec<u8>) -> Result<String, String> {
    if png.len() < 8 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("not a PNG".into());
    }
    let dir = std::env::temp_dir().join("obpterm");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("paste-{stamp}.png"));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::allow_rule;

    #[test]
    fn allow_rule_appends_once_and_survives_junk() {
        let dir = std::env::temp_dir().join(format!("obpterm-allow-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.display().to_string();
        allow_rule(cwd.clone(), "Bash(npm:*)".into()).unwrap();
        allow_rule(cwd.clone(), "Bash(npm:*)".into()).unwrap(); // twice: no duplicate
        let text = std::fs::read_to_string(dir.join(".claude/settings.local.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let allow = v.pointer("/permissions/allow").unwrap().as_array().unwrap();
        assert_eq!(allow.len(), 1);
        assert_eq!(allow[0], "Bash(npm:*)");
        assert!(allow_rule(cwd, "".into()).is_err(), "an empty rule is refused");
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// One git call, trimmed stdout, None on failure — the worktree helpers all speak this.
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = quiet(std::process::Command::new("git").arg("-C").arg(cwd).args(args)).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct WorktreeStatus {
    /// The main checkout this worktree hangs off.
    pub main_root: String,
    pub path: String,
    pub branch: String,
    pub clean: bool,
    /// HEAD is contained in master/main — removing the worktree loses nothing.
    pub merged: bool,
}

/// What the janitor needs to know about a directory: is it a LINKED worktree, and is it safe
/// to sweep. None for the main checkout, a non-repo, or anything git will not answer for.
#[tauri::command]
pub fn worktree_status(cwd: String) -> Option<WorktreeStatus> {
    let git_dir = git(&cwd, &["rev-parse", "--git-dir"])?;
    let common = git(&cwd, &["rev-parse", "--git-common-dir"])?;
    if git_dir == common {
        return None; // the main checkout, not a linked worktree
    }
    let path = git(&cwd, &["rev-parse", "--show-toplevel"])?;
    // The main root is the common dir's parent (…/repo/.git -> …/repo).
    let main_root = PathBuf::from(&common).parent()?.display().to_string();
    let branch = git(&cwd, &["branch", "--show-current"])?;
    let clean = git(&cwd, &["status", "--porcelain"])?.is_empty();
    let merged = ["master", "main"].iter().any(|base| {
        quiet(std::process::Command::new("git").args(["-C", &cwd, "merge-base", "--is-ancestor", "HEAD", base]))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    });
    Some(WorktreeStatus { main_root, path, branch, clean, merged })
}

/// `git worktree add` as a sibling of the repo: `<root>-<name>`, on branch `<name>` (created,
/// or reused when it already exists). Returns the new directory.
#[tauri::command]
pub fn worktree_add(cwd: String, name: String) -> Result<String, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) || name.is_empty() || name.len() > 60 {
        return Err("worktree names are letters, digits, - _ . only".into());
    }
    let root = git(&cwd, &["rev-parse", "--show-toplevel"]).ok_or("not inside a git repository")?;
    let target = format!("{root}-{name}");
    if std::path::Path::new(&target).exists() {
        return Err(format!("{target} already exists"));
    }
    let run = |args: &[&str]| -> Result<(), String> {
        let out = quiet(std::process::Command::new("git").arg("-C").arg(&root).args(args)).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    };
    // A fresh branch first; an existing one second — reusing it is what the user meant.
    run(&["worktree", "add", "-b", &name, &target])
        .or_else(|first| run(&["worktree", "add", &target, &name]).map_err(|_| first))?;
    Ok(target)
}

/// The other half of `worktree_add`: remove the checkout and its branch. `-d` only — an
/// unmerged branch refuses, which is the safety this command leans on.
#[tauri::command]
pub fn worktree_remove(main_root: String, path: String, branch: String) -> Result<(), String> {
    let run = |args: &[&str]| -> Result<(), String> {
        let out = quiet(std::process::Command::new("git").arg("-C").arg(&main_root).args(args)).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    };
    run(&["worktree", "remove", &path])?;
    if !branch.is_empty() {
        run(&["branch", "-d", &branch])?;
    }
    Ok(())
}

#[cfg(test)]
mod worktree_tests {
    use super::*;

    #[test]
    fn add_status_remove_round_trip() {
        let base = std::env::temp_dir().join(format!("obpterm-wt-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let cwd = repo.display().to_string();
        let sh = |args: &[&str]| {
            assert!(quiet(std::process::Command::new("git").arg("-C").arg(&cwd).args(args)).status().unwrap().success(), "{args:?}");
        };
        sh(&["init", "-b", "master"]);
        sh(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "root"]);

        assert_eq!(worktree_status(cwd.clone()), None, "the main checkout is not a linked worktree");

        let wt = worktree_add(cwd.clone(), "feature-x".into()).unwrap();
        let status = worktree_status(wt.clone()).expect("the new worktree reports");
        assert_eq!(status.branch, "feature-x");
        assert!(status.clean && status.merged, "fresh from master: clean and merged");

        // Dirty it: no longer sweepable-looking.
        std::fs::write(std::path::Path::new(&wt).join("x.txt"), "x").unwrap();
        assert!(!worktree_status(wt.clone()).unwrap().clean);
        std::fs::remove_file(std::path::Path::new(&wt).join("x.txt")).unwrap();

        worktree_remove(status.main_root, wt.clone(), "feature-x".into()).unwrap();
        assert!(!std::path::Path::new(&wt).exists());
        std::fs::remove_dir_all(&base).ok();
    }
}
