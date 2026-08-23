//! Claude Code login switching, for the window: the pure logic is `obpterm_host::logins`.
use obpterm_host::logins::{self, Logins};
use std::path::PathBuf;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "no home directory".to_string())
}

/// How many `claude` processes are running. A live session rotates its token and would write
/// it over a swapped-in file, so a switch refuses while any exist.
fn claude_running() -> usize {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .values()
        .filter(|p| {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            name == "claude" || name == "claude.exe"
        })
        .count()
}

#[tauri::command]
pub fn logins_list() -> Result<Logins, String> {
    Ok(logins::listing(&home_dir()?, claude_running()))
}

#[tauri::command]
pub fn logins_save(name: String) -> Result<Logins, String> {
    let home = home_dir()?;
    logins::save(&home, &name)?;
    Ok(logins::listing(&home, claude_running()))
}

#[tauri::command]
pub fn logins_switch(name: String) -> Result<Logins, String> {
    let home = home_dir()?;
    logins::switch(&home, &name, claude_running())?;
    Ok(logins::listing(&home, claude_running()))
}

#[tauri::command]
pub fn logins_forget(name: String) -> Result<Logins, String> {
    let home = home_dir()?;
    logins::forget(&home, &name)?;
    Ok(logins::listing(&home, claude_running()))
}

