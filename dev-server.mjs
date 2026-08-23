// Browser dev loop for the UI: real shells via node-pty behind a WebSocket on :1421.
// Usage: `npm run devserver` here, `npm run dev` in another shell, open http://<host>:1420.
// Protocol mirrors transport-ws.ts; config lives in ./dev-config.json.
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const CONFIG = new URL("./dev-config.json", import.meta.url);
const wss = new WebSocketServer({ port: 1421 });
let nextId = 1;

wss.on("connection", (ws) => {
  const sessions = new Map();
  const logs = new Map();
  const reply = (reqId, body = {}) => ws.send(JSON.stringify({ reqId, ...body }));

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    try {
      switch (m.t) {
        case "spawn": {
          const { profile, cols, rows } = m;
          const p = pty.spawn(profile.exe, profile.args ?? [], {
            name: "xterm-256color",
            cols, rows,
            cwd: profile.cwd ?? os.homedir(),
            env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", WINTERM: "dev" },
          });
          const id = nextId++;
          sessions.set(id, p);
          const head = Buffer.alloc(4);
          head.writeUInt32BE(id);
          p.onData((d) => {
            logs.get(id)?.write(d);
            if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([head, Buffer.from(d)]));
          });
          p.onExit(({ exitCode }) => {
            sessions.delete(id);
            logs.get(id)?.end();
            logs.delete(id);
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "exit", id, code: exitCode }));
          });
          return reply(m.reqId, { id });
        }
        case "write": sessions.get(m.id)?.write(m.data); return reply(m.reqId);
        case "resize": sessions.get(m.id)?.resize(m.cols, m.rows); return reply(m.reqId);
        case "kill": sessions.get(m.id)?.kill(); return reply(m.reqId);
        case "log_start": {
          mkdirSync("logs", { recursive: true });
          const path = `logs/${m.name.replace(/[^\w-]/g, "-")}-${m.stamp}.log`;
          logs.set(m.id, createWriteStream(path));
          return reply(m.reqId, { path });
        }
        case "log_stop": logs.get(m.id)?.end(); logs.delete(m.id); return reply(m.reqId);
        case "config_load": return reply(m.reqId, { config: JSON.parse(readFileSync(CONFIG, "utf8")) });
        case "config_save": writeFileSync(CONFIG, JSON.stringify(m.config, null, 2) + "\n"); return reply(m.reqId);
        default: return reply(m.reqId, { error: `unknown message ${m.t}` });
      }
    } catch (e) {
      reply(m.reqId, { error: String(e) });
    }
  });
  ws.on("close", () => sessions.forEach((p) => p.kill()));
});
console.log("winterm dev-server: ws://0.0.0.0:1421 (config: dev-config.json)");
