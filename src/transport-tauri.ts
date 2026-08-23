import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Config, Profile, Transport } from "./transport";

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
    loadConfig: () => invoke<Config>("config_load"),
    saveConfig: (config) => invoke("config_save", { config }),
    configPath: () => invoke<string>("config_path_string"),
    readClipboard: () => readText(),
    writeClipboard: (text) => writeText(text),
  };
}
