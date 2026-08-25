import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { ClaudeAccount, ClaudeLimits, ClaudeUsage, Logins, Config, HostInfo, HostMetrics, HostSession, Profile, ReleaseInfo, Session, Transport } from "./transport";

export function tauriTransport(): Transport {
  const exits = new Map<number, (code: number | null) => void>();
  void listen<{ id: number; code: number | null }>("pty:exit", (e) => {
    const cb = exits.get(e.payload.id);
    exits.delete(e.payload.id);
    cb?.(e.payload.code);
  });

  return {
    native: true,
    hostInfo: () => invoke<HostInfo>("host_info"),
    listSessions: () => invoke<HostSession[]>("pty_list"),
    async attach(id, cols, rows, onData, onExit) {
      const onDataCh = new Channel<ArrayBuffer>();
      onDataCh.onmessage = (buf) => onData(new Uint8Array(buf));
      await invoke("pty_attach", { id, cols, rows, onData: onDataCh });
      exits.set(id, onExit);
    },
    detach: (id) => invoke("pty_detach", { id }),
    onAgent: (handler) => void listen("agent", (e) => handler(e.payload as import("./agent").AgentUpdate)),
    agentAnswer: (pending, allow) => invoke("agent_answer", { pending, allow }),
    hooksEnsure: (dirs) => invoke<string[]>("hooks_ensure", { dirs }),
    hooksRemove: (dirs) => invoke<number>("hooks_remove", { dirs }),
    sessionTitle: (dir, sessionId) => invoke<string | null>("session_title", { dir, sessionId }),
    hostShutdown: () => invoke("host_shutdown"),
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
    async logStart(id, name, stamp, dir) {
      return invoke<string>("pty_log_start", { id, dir: dir || (await invoke<string>("log_dir")), name, stamp });
    },
    logStop: (id) => invoke("pty_log_stop", { id }),
    hostMetrics: (cwd) => invoke<HostMetrics>("host_metrics", { cwd }),
    appVersion: () => invoke<string>("app_version"),
    updateCheck: (repo, token) => invoke<ReleaseInfo>("update_check", { repo, token }),
    updateInstall: (release, token) => invoke<string>("update_install", { release, token }),
    claudeAccountNames: (dir) => invoke<string[]>("claude_account_names", { dir }),
    windowAction: (label, action) => invoke("window_action", { label, action }),
    async notify(title, body) {
      // Asking on first use, not at launch: a terminal that demands notification permission
      // before it has anything to say is the wrong first impression.
      if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return false;
      sendNotification({ title, body });
      return true;
    },
    attention: (on) => invoke("attention", { on }),
    async badge(count) {
      // Drawn here because the webview already has a canvas and the brand font; Rust only
      // hands the pixels to the taskbar.
      if (!count) return invoke("taskbar_badge", { rgba: [], size: 0 });
      const size = 32;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d")!;
      g.beginPath();
      g.arc(16, 16, 15, 0, Math.PI * 2);
      g.fillStyle = "#ff8a1e";
      g.fill();
      g.fillStyle = "#04101f";
      g.font = "700 19px 'Plus Jakarta Sans', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(count > 9 ? "9+" : String(count), 16, 17);
      const rgba = Array.from(g.getImageData(0, 0, size, size).data);
      return invoke("taskbar_badge", { rgba, size });
    },
    configReset: () => invoke<Config>("config_reset"),
    configExport: (config) => invoke<string>("config_export", { config }),
    ntfy: (url, token, title, body) => invoke("ntfy_publish", { url, token, title, body }),
    keepAwake: (on) => invoke("keep_awake", { on }),
    rssFor: (pids) => invoke<number[]>("rss_for", { pids }),
    gitShortstat: (cwd) => invoke<string | null>("git_shortstat", { cwd }),
    allowRule: (cwd, rule) => invoke("allow_rule", { cwd, rule }),
    sessionContext: (dir, sessionId) => invoke<number | null>("session_context", { dir, sessionId }),
    async readClipboardImage() {
      // The plugin hands back raw RGBA; a canvas turns it into the PNG the temp file needs.
      try {
        const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
        const img = await readImage();
        const size = await img.size();
        const rgba = await img.rgba();
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const g = canvas.getContext("2d")!;
        g.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob) return null;
        const png = Array.from(new Uint8Array(await blob.arrayBuffer()));
        return await invoke<string>("save_clip_image", { png });
      } catch {
        return null; // no image on the clipboard, or the platform refused
      }
    },
    reveal: (what) => invoke<string>("reveal", { what }),
    sessionLoad: () => invoke<Session>("session_load"),
    sessionSave: (tabs, active, host) => invoke("session_save", { tabs, active, host }),
    captureStats: (dir) => invoke<[number, number, number]>("capture_stats", { dir }),
    pruneCaptures: (dir, keepDays, maxMb) => invoke<[number, number]>("prune_captures", { dir, keepDays, maxMb }),
    logDir: () => invoke<string>("log_dir"),
    claudeAccount: (dir) => invoke<ClaudeAccount>("claude_account", { dir }),
    claudeUsage: (dir) => invoke<ClaudeUsage>("claude_usage", { dir }),
    claudeLimits: (file, url) => invoke<ClaudeLimits | null>("claude_limits", { file, url }),
    logins: (action, name) => invoke<Logins>(`logins_${action}`, name ? { name } : {}),
    loadConfig: () => invoke<Config>("config_load"),
    saveConfig: (config) => invoke("config_save", { config }),
    configPath: () => invoke<string>("config_path_string"),
    readClipboard: () => readText(),
    writeClipboard: (text) => writeText(text),
  };
}
