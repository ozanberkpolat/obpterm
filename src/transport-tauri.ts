import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ClaudeAccount, ClaudeUsage, Config, HostMetrics, Profile, ReleaseInfo, Session, Transport } from "./transport";

export function tauriTransport(): Transport {
  const exits = new Map<number, (code: number | null) => void>();
  void listen<{ id: number; code: number | null }>("pty:exit", (e) => {
    const cb = exits.get(e.payload.id);
    exits.delete(e.payload.id);
    cb?.(e.payload.code);
  });

  return {
    native: true,
    async spawn(profile: Profile, cols, rows, onData, onExit) {
      // Rust sends `Response::new(bytes)` → arrives as an ArrayBuffer, no JSON in between.
      const onDataCh = new Channel<ArrayBuffer>();
      onDataCh.onmessage = (buf) => onData(new Uint8Array(buf));
      const id = await invoke<number>("pty_spawn", { profile, cols, rows, onData: onDataCh });
      exits.set(id, onExit);
      return id;
    },
    write: (id, data) => invoke("pty_write", { id, data }),
    resize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
    kill: (id) => invoke("pty_kill", { id }),
    async logStart(id, name, stamp) {
      return invoke<string>("pty_log_start", { id, dir: await invoke<string>("log_dir"), name, stamp });
    },
    logStop: (id) => invoke("pty_log_stop", { id }),
    hostMetrics: (cwd) => invoke<HostMetrics>("host_metrics", { cwd }),
    appVersion: () => invoke<string>("app_version"),
    updateCheck: (repo, token) => invoke<ReleaseInfo>("update_check", { repo, token }),
    updateInstall: (release, token) => invoke<string>("update_install", { release, token }),
    claudeAccountNames: (dir) => invoke<string[]>("claude_account_names", { dir }),
    sessionLoad: () => invoke<Session>("session_load"),
    sessionSave: (tabs) => invoke("session_save", { tabs }),
    claudeAccount: (dir) => invoke<ClaudeAccount>("claude_account", { dir }),
    claudeUsage: (dir) => invoke<ClaudeUsage>("claude_usage", { dir }),
    loadConfig: () => invoke<Config>("config_load"),
    saveConfig: (config) => invoke("config_save", { config }),
    configPath: () => invoke<string>("config_path_string"),
    readClipboard: () => readText(),
    writeClipboard: (text) => writeText(text),
  };
}
