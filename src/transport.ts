// The one seam between the UI and whatever provides shells: Tauri IPC in the real app,
// a WebSocket to dev-server.mjs when the UI is opened in a plain browser for iteration.

export interface Profile {
  id: string;
  name: string;
  exe: string;
  args: string[];
  cwd: string | null;
  env?: Record<string, string>;
  /** Start capturing to a log as soon as the shell opens. */
  capture?: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  /** Press Enter for you, instead of leaving it on the prompt. */
  send: boolean;
}

export interface Account {
  id: string;
  name: string;
  /** Extra environment for shells started under this account (CLAUDE_CONFIG_DIR, AWS_PROFILE, …). */
  env: Record<string, string>;
  /** Claude Code config dir to read the login + token meters from. */
  claude_dir: string | null;
  color: string | null;
}

export interface Host {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  identity: string | null;
  project: string | null;
}

/** What Claude Code's own files say about the login in a config dir. */
export interface ClaudeAccount {
  dir: string;
  name: string | null;
  email: string | null;
  organization: string | null;
  tier: string | null;
  exists: boolean;
}

export interface UsageBucket {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  messages: number;
  billed: number;
}

export interface ClaudeUsage {
  dir: string;
  window_5h: UsageBucket;
  window_7d: UsageBucket;
  last_activity: number | null;
  files_scanned: number;
}

/** The tabs that were open, and whether the app got to close normally last time. */
export interface Session {
  clean_exit: boolean;
  saved_at: number;
  tabs: unknown;
  /** Index of the tab that was in front. */
  active: number;
  /** Version just installed, when the last exit was an update restart. */
  updated_to: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  cwd: string | null;
  default_profile: string | null;
  /** Tabs saved by "Save layout"; shape from src/layout.ts (SavedTab[]). */
  layout: unknown | null;
  collapsed: boolean;
}

export interface ReleaseInfo {
  version: string;
  name: string;
  url: string;
  notes: string;
  newer: boolean;
}

export interface HostMetrics {
  cpu: number;
  mem_used: number;
  mem_total: number;
  swap_used: number;
  swap_total: number;
  disk_used: number;
  disk_total: number;
  disk_name: string;
}

export interface Config {
  default_profile: string;
  profiles: Profile[];
  font_family: string;
  font_size: number;
  scrollback: number;
  rail_collapsed: boolean;
  rail_width: number;
  cursor_style: "bar" | "block" | "underline";
  cursor_blink: boolean;
  right_click_paste: boolean;
  copy_on_select: boolean;
  accent: string;
  dim_inactive_panes: boolean;
  capture_dir: string | null;
  update_check_on_launch: boolean;
  default_cwd: string | null;
  update_repo: string | null;
  github_token: string | null;
  projects: Project[];
  accounts: Account[];
  hosts: Host[];
  snippets: Snippet[];
  default_account: string | null;
  quota_5h_tokens: number | null;
  quota_7d_tokens: number | null;
  restore_session: boolean;
  /** Tabs open at last quit; shape from src/layout.ts (SavedTab[]). */
  session: unknown | null;
  theme: Record<string, string>;
}

export interface Transport {
  spawn(
    profile: Profile,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
    onExit: (code: number | null) => void,
  ): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  kill(id: number): Promise<void>;
  /** Starts teeing this session to a file; returns the path. */
  logStart(id: number, name: string, stamp: string, dir: string | null): Promise<string>;
  logStop(id: number): Promise<void>;
  hostMetrics(cwd: string | null): Promise<HostMetrics>;
  appVersion(): Promise<string>;
  /** Writes the installer to a temp file, launches it and quits. */
  /** Asks GitHub for the newest release (done in Rust: the webview cannot follow GitHub's asset redirect). */
  updateCheck(repo: string, token: string | null): Promise<ReleaseInfo>;
  /** Downloads that release's installer and runs it; the app exits on success. */
  updateInstall(release: ReleaseInfo, token: string | null): Promise<string>;
  /** Logins Claude Code has stored in a config dir. */
  claudeAccountNames(dir: string): Promise<string[]>;
  /** minimize | maximize | close, for our own title bar. */
  windowAction(label: string, action: "minimize" | "maximize" | "close"): Promise<void>;
  configReset(): Promise<Config>;
  reveal(what: "config" | "logs"): Promise<string>;
  sessionLoad(): Promise<Session>;
  sessionSave(tabs: unknown, active: number): Promise<void>;
  claudeAccount(dir: string): Promise<ClaudeAccount>;
  claudeUsage(dir: string): Promise<ClaudeUsage>;
  loadConfig(): Promise<Config>;
  saveConfig(config: Config): Promise<void>;
  configPath(): Promise<string>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  /** true inside the Tauri app, false in the browser dev loop */
  readonly native: boolean;
}

/** A config written by an older version (or hand-edited) is missing the newer keys. */
export function withDefaults(config: Partial<Config>): Config {
  return {
    default_profile: config.default_profile ?? config.profiles?.[0]?.id ?? "",
    profiles: config.profiles?.length ? config.profiles : [],
    font_family: config.font_family ?? "JetBrains Mono, Cascadia Mono, Consolas, monospace",
    font_size: config.font_size ?? 14,
    scrollback: config.scrollback ?? 10_000,
    rail_collapsed: config.rail_collapsed ?? false,
    rail_width: config.rail_width ?? 232,
    cursor_style: config.cursor_style ?? "bar",
    cursor_blink: config.cursor_blink ?? true,
    right_click_paste: config.right_click_paste ?? true,
    copy_on_select: config.copy_on_select ?? true,
    accent: config.accent ?? "#ff8a1e",
    dim_inactive_panes: config.dim_inactive_panes ?? true,
    capture_dir: config.capture_dir ?? null,
    update_check_on_launch: config.update_check_on_launch ?? true,
    default_cwd: config.default_cwd ?? null,
    update_repo: config.update_repo ?? "ozanberkpolat/obpterm",
    github_token: config.github_token ?? null,
    accounts: config.accounts ?? [],
    hosts: config.hosts ?? [],
    snippets: config.snippets ?? [],
    default_account: config.default_account ?? null,
    quota_5h_tokens: config.quota_5h_tokens ?? null,
    quota_7d_tokens: config.quota_7d_tokens ?? null,
    projects: (config.projects ?? []).map((p) => ({
      ...p,
      cwd: p.cwd ?? null,
      default_profile: p.default_profile ?? null,
      layout: p.layout ?? null,
      collapsed: p.collapsed ?? false,
    })),
    restore_session: config.restore_session ?? true,
    session: config.session ?? null,
    theme: config.theme ?? {},
  };
}

export async function pickTransport(): Promise<Transport> {
  if ("__TAURI_INTERNALS__" in window) {
    return (await import("./transport-tauri")).tauriTransport();
  }
  return (await import("./transport-ws")).wsTransport();
}
