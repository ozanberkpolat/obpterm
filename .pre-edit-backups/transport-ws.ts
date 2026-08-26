// Browser dev loop: `npm run devserver` (node-pty behind a WebSocket on :1421) + `npm run dev`.
// Wire format: JSON text frames for control, binary frames = 4-byte big-endian session id + bytes.
import type { ClaudeAccount, ClaudeUsage, Config, HostInfo, HostMetrics, HostSession, Logins, Profile, ReleaseInfo, Session, Transport } from "./transport";

type Msg = { t: string; id?: number; reqId?: number; [k: string]: unknown };

export function wsTransport(): Transport {
  const ws = new WebSocket(`ws://${location.hostname}:1421`);
  ws.binaryType = "arraybuffer";
  const ready = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("dev-server :1421 not reachable — run `npm run devserver`"));
  });
  const pending = new Map<number, (m: Msg) => void>();
  const agentListeners: ((u: import("./agent").AgentUpdate) => void)[] = [];
  const data = new Map<number, (b: Uint8Array) => void>();
  const exits = new Map<number, (code: number | null) => void>();
  let reqSeq = 0;

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const view = new DataView(ev.data);
      data.get(view.getUint32(0))?.(new Uint8Array(ev.data, 4));
      return;
    }
    const m: Msg = JSON.parse(ev.data);
    if (m.reqId !== undefined) {
      pending.get(m.reqId)?.(m);
      pending.delete(m.reqId);
    } else if (m.t === "agent") {
      for (const l of agentListeners) l(m.update as import("./agent").AgentUpdate);
    } else if (m.t === "config:changed") {
      // one window now: nothing to reconcile
    } else if (m.t === "exit" && m.id !== undefined) {
      exits.get(m.id)?.((m.code as number | null) ?? null);
      exits.delete(m.id);
      data.delete(m.id);
    }
  };

  async function call(t: string, body: Record<string, unknown> = {}): Promise<Msg> {
    await ready;
    const reqId = ++reqSeq;
    return new Promise((res, rej) => {
      pending.set(reqId, (m) => (m.error ? rej(new Error(String(m.error))) : res(m)));
      ws.send(JSON.stringify({ t, reqId, ...body }));
    });
  }

  return {
    native: false,
    // The dev server holds its ptys across page reloads, so it plays the host's part too.
    hostInfo: async () => (await call("host_info")).info as HostInfo,
    listSessions: async () => (await call("list")).sessions as HostSession[],
    async attach(id, cols, rows, onData, onExit) {
      await call("attach", { id, cols, rows });
      data.set(id, onData);
      exits.set(id, onExit);
    },
    onAgent: (handler) => agentListeners.push(handler),
    agentAnswer: async (pending, allow) => void (await call("agent_answer", { pending, allow })),
    hooksEnsure: async () => [],
    hooksRemove: async () => 0,
    sessionTitle: async () => null,
    detach: async (id) => {
      data.delete(id);
      exits.delete(id);
      await call("detach", { id });
    },
    hostShutdown: async () => void (await call("shutdown")),
    hostRestart: async () => "dev",
    async spawn(profile: Profile, cols, rows, onData, onExit) {
      const m = await call("spawn", { profile, cols, rows });
      const id = m.id as number;
      data.set(id, onData);
      exits.set(id, onExit);
      return id;
    },
    write: async (id, text) => void (await call("write", { id, data: text })),
    resize: async (id, cols, rows) => void (await call("resize", { id, cols, rows })),
    kill: async (id) => void (await call("kill", { id })),
    logStart: async (id, name, stamp, dir) => (await call("log_start", { id, name, stamp, dir })).path as string,
    logStop: async (id) => void (await call("log_stop", { id })),
    hostMetrics: async (cwd) => (await call("host_metrics", { cwd })).metrics as HostMetrics,
    appVersion: async () => (await call("app_version")).version as string,
    updateCheck: async (repo) => {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
      const release = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
      const asset = release.assets?.find((a) => a.name.endsWith("-setup.exe"));
      return {
        version: (release.tag_name ?? "0").replace(/^v/, ""),
        name: asset?.name ?? "",
        url: asset?.browser_download_url ?? "",
        notes: release.body ?? "",
        newer: false, // the browser build is never the thing being updated
      } satisfies ReleaseInfo;
    },
    updateInstall: async (release) => {
      throw new Error(`installers only run in the app, not the browser (${release.name})`);
    },
    claudeAccountNames: async (dir) => (await call("claude_account_names", { dir })).names as string[],
    windowAction: async () => {},
    startDrag: async () => {},
    async notify(title, body) {
      // The browser loop gets the same behaviour through the standard API.
      if (!("Notification" in window)) return false;
      if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return false;
      new Notification(title, { body });
      return true;
    },
    attention: async () => {},
    badge: async () => {},
    configExport: async () => "(dev: export is a desktop feature)",
    ntfy: async () => {},
    keepAwake: async () => {},
    rssFor: async (pids) => pids.map(() => 0),
    gitShortstat: async () => null,
    allowRule: async () => {},
    sessionContext: async () => null,
    readClipboardImage: async () => null,
    worktreeStatus: async () => null,
    worktreeAdd: async () => { throw new Error("worktrees are a desktop feature"); },
    worktreeRemove: async () => {},
    configReset: async () => (await call("config_reset")).config as Config,
    reveal: async (what) => what,
    sessionLoad: async () => (await call("session_load")).session as Session,
    sessionSave: async (tabs, active, host) => void (await call("session_save", { tabs, active, host })),
    captureStats: async () => [0, 0, 0],
    pruneCaptures: async () => [0, 0] as [number, number],
    logDir: async () => "logs",
    claudeAccount: async (dir) => (await call("claude_account", { dir })).account as ClaudeAccount,
    claudeUsage: async (dir) => (await call("claude_usage", { dir })).usage as ClaudeUsage,
    claudeLimits: async () => null,
    logins: async (action, name) => (await call("logins", { action, name })).logins as Logins,
    loadConfig: async () => (await call("config_load")).config as Config,
    saveConfig: async (config) => void (await call("config_save", { config })),
    configPath: async () => "dev-config.json (dev server)",
    readClipboard: () => navigator.clipboard.readText(),
    writeClipboard: (text) => navigator.clipboard.writeText(text),
  };
}
