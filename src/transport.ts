// The one seam between the UI and whatever provides shells: Tauri IPC in the real app,
// a WebSocket to dev-server.mjs when the UI is opened in a plain browser for iteration.

export interface Profile {
  id: string;
  name: string;
  exe: string;
  args: string[];
  cwd: string | null;
}

export interface Config {
  default_profile: string;
  profiles: Profile[];
  font_family: string;
  font_size: number;
  scrollback: number;
  rail_collapsed: boolean;
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
  loadConfig(): Promise<Config>;
  saveConfig(config: Config): Promise<void>;
  configPath(): Promise<string>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  /** true inside the Tauri app, false in the browser dev loop */
  readonly native: boolean;
}

export async function pickTransport(): Promise<Transport> {
  if ("__TAURI_INTERNALS__" in window) {
    return (await import("./transport-tauri")).tauriTransport();
  }
  return (await import("./transport-ws")).wsTransport();
}
