// The one seam between the UI and whatever provides shells: Tauri IPC in the real app,
// a WebSocket to dev-server.mjs when the UI is opened in a plain browser for iteration.

export interface Profile {
  id: string;
  name: string;
  exe: string;
  args: string[];
  cwd: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  cwd: string | null;
  default_profile: string | null;
  /** Tabs saved by "Save layout"; shape from src/layout.ts (SavedTab[]). */
  layout: unknown | null;
}

export interface Config {
  default_profile: string;
  profiles: Profile[];
  font_family: string;
  font_size: number;
  scrollback: number;
  rail_collapsed: boolean;
  projects: Project[];
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
  logStart(id: number, name: string, stamp: string): Promise<string>;
  logStop(id: number): Promise<void>;
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
    projects: (config.projects ?? []).map((p) => ({ ...p, cwd: p.cwd ?? null, default_profile: p.default_profile ?? null, layout: p.layout ?? null })),
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
