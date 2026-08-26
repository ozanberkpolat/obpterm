//! `obpterm-host <config-dir>`: serve until shutdown or idle, advertising in `<config-dir>/host.json`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use obpterm_host::server::Host;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Two per-event modes that Claude Code runs, hundreds of times in an agent fan-out. They do
    // their job and exit; nothing here starts a server. See `cli.rs` for why they are not shell.
    match std::env::args().nth(1).as_deref() {
        Some("statusline") => return obpterm_host::cli::statusline(),
        Some("hook") => return obpterm_host::cli::hook(),
        _ => {}
    }
    let config_dir = std::env::args().nth(1).map(std::path::PathBuf::from).unwrap_or_else(|| {
        eprintln!("usage: obpterm-host <config-dir> | statusline | hook");
        std::process::exit(2);
    });
    std::fs::create_dir_all(&config_dir).expect("config dir");
    let socket = format!("obpterm-{}", obpterm_host::random_hex(8));
    let host = Arc::new(Host::new(socket, obpterm_host::random_hex(16), env!("CARGO_PKG_VERSION")));

    if let Err(e) = host.start_hooks(&config_dir).await {
        eprintln!("obpterm-host: hooks disabled: {e}");
    }
    let advert = obpterm_host::advert_path(&config_dir);
    std::fs::write(&advert, serde_json::to_string_pretty(&host.advert).unwrap()).expect("write host.json");

    let reason = Arc::clone(&host).serve().await;
    // Leave no stale advert behind: a client reading one would try to connect to nothing.
    let _ = std::fs::remove_file(&advert);
    match reason {
        Ok(why) => eprintln!("obpterm-host: exiting ({why})"),
        Err(e) => eprintln!("obpterm-host: {e}"),
    }
}
