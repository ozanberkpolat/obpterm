// Browser dev loop: `npm run devserver` (node-pty behind a WebSocket on :1421) + `npm run dev`.
// Wire format: JSON text frames for control, binary frames = 4-byte big-endian session id + bytes.
import type { Config, Profile, Transport } from "./transport";

type Msg = { t: string; id?: number; reqId?: number; [k: string]: unknown };

export function wsTransport(): Transport {
  const ws = new WebSocket(`ws://${location.hostname}:1421`);
  ws.binaryType = "arraybuffer";
  const ready = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("dev-server :1421 not reachable — run `npm run devserver`"));
  });
  const pending = new Map<number, (m: Msg) => void>();
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
    loadConfig: async () => (await call("config_load")).config as Config,
    saveConfig: async (config) => void (await call("config_save", { config })),
    configPath: async () => "dev-config.json (dev server)",
    readClipboard: () => navigator.clipboard.readText(),
    writeClipboard: (text) => navigator.clipboard.writeText(text),
  };
}
