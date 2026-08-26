//! "Check for updates" without an update server: the frontend asks the GitHub releases API
//! (with the token from config.json when the repo is private), and hands the installer bytes
//! back here to be written and launched. Rust does no networking.

use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::AppHandle;

const USER_AGENT: &str = concat!("OBPTerm/", env!("CARGO_PKG_VERSION"));

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub url: String,
    pub notes: String,
    /// True when `version` is newer than the running build.
    pub newer: bool,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// The version this binary was built as — what the check compares against.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Asks GitHub for the newest release of `repo` ("owner/name"). `token` is only needed while
/// the repository is private.
#[tauri::command]
pub async fn update_check(repo: String, token: Option<String>) -> Result<Release, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = request(&url, token).await?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            404 => "no release found (a private repo needs github_token in config.json)".into(),
            code => format!("GitHub returned {code}"),
        });
    }
    let release: GhRelease = response.json().await.map_err(|e| format!("bad response: {e}"))?;
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with("-setup.exe"))
        .ok_or("that release has no installer attached")?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    Ok(Release {
        newer: is_newer(&version, env!("CARGO_PKG_VERSION")),
        version,
        name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        notes: release.body,
    })
}

/// Downloads the installer and runs it. Returns only if something went wrong — on success the
/// app is on its way out.
#[tauri::command]
pub async fn update_install(app: AppHandle, release: Release, token: Option<String>) -> Result<String, String> {
    let response = request(&release.url, token).await?;
    if !response.status().is_success() {
        return Err(format!("download returned {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| format!("download failed: {e}"))?;
    run_installer(app, release.name, release.version, bytes.to_vec())
}

async fn request(url: &str, token: Option<String>) -> Result<reqwest::Response, String> {
    // Without a timeout a single stalled connection leaves the caller waiting forever — which
    // is exactly what a chip stuck on "Checking…" is.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| format!("{e}"))?;
    let mut req = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send().await.map_err(|e| format!("{e}"))
}

/// Plain numeric compare of dotted versions; a suffix like "-beta" sorts before the release.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| {
        v.split(['.', '-'])
            .map(|p| p.parse::<i64>().unwrap_or(-1))
            .collect::<Vec<_>>()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Writes the downloaded installer to the temp dir and starts it **silently, with a restart**.
///
/// Windows cannot replace a running executable, so there is no true in-place update: the NSIS
/// installer's `/S` kills this process without a prompt and `/R` starts the new build once it is
/// in place. The session file was already written, so the new process reopens every tab.
pub fn run_installer(app: AppHandle, name: String, version: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() < 100_000 {
        return Err(format!("{name} is only {} bytes — refusing to run it", bytes.len()));
    }
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '-' })
        .collect();
    let path = std::env::temp_dir().join(safe);
    let mut file = std::fs::File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    file.write_all(&bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    drop(file);

    crate::config::mark_updating(&app, &version);
    std::process::Command::new(&path)
        .args(["/S", "/R"])
        .spawn()
        .map_err(|e| format!("start {}: {e}", path.display()))?;
    let handle = app.clone();
    // Give the installer a moment to come up before this process disappears from under it.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        handle.exit(0);
    });
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn version_comparison() {
        assert!(is_newer("0.4.1", "0.4.0"));
        assert!(is_newer("0.10.0", "0.9.9"), "10 is not less than 9");
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.4.1", "0.4.1"), "the same build is not an update");
        assert!(!is_newer("0.4.0", "0.4.1"), "never offer to go backwards");
        assert!(!is_newer("0.4.1-beta", "0.4.1"), "a prerelease of the same version is not newer");
    }
}

/// One push to the user's own ntfy. Only ever called with a URL the user configured — the
/// app contacts nothing by default. The Title header must be latin-1 or ntfy drops the push
/// silently (fleet scar tissue), so anything outside it becomes '?'.
#[tauri::command]
pub async fn ntfy_publish(url: String, token: Option<String>, title: String, body: String) -> Result<(), String> {
    let latin1: String = title.chars().map(|c| if (c as u32) < 256 { c } else { '?' }).collect();
    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("Title", latin1)
        .header("Priority", "high")
        .header("Tags", "robot")
        .timeout(std::time::Duration::from_secs(6))
        .body(body);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    let response = req.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("ntfy said {}", response.status()));
    }
    Ok(())
}

#[cfg(test)]
mod ntfy_tests {
    #[test]
    fn latin1_sanitize() {
        // The em dash and the check mark are outside latin-1 and must degrade; ç and ö are
        // inside it and must survive.
        let title = "Agent \u{2705} blocked \u{2014} çök";
        let out: String = title.chars().map(|c| if (c as u32) < 256 { c } else { '?' }).collect();
        assert_eq!(out, "Agent ? blocked ? çök");
    }
}
