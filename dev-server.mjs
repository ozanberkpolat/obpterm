// Browser dev loop for the UI: real shells via node-pty behind a WebSocket on :1421.
// Usage: `npm run devserver` here, `npm run dev` in another shell, open http://<host>:1420.
// Protocol mirrors transport-ws.ts; config lives in ./dev-config.json.
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";

const CONFIG = new URL("./dev-config.json", import.meta.url);
const SESSION = new URL("./dev-session.json", import.meta.url);
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
            cwd: expand(profile.cwd) ?? os.homedir(),
            env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", OBPTERM: "dev" },
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
        case "host_metrics": return reply(m.reqId, { metrics: hostMetrics() });
        case "app_version": return reply(m.reqId, { version: "0.0.0-dev" });
        case "session_load": {
          try { return reply(m.reqId, { session: JSON.parse(readFileSync(SESSION, "utf8")) }); }
          catch { return reply(m.reqId, { session: { clean_exit: true, saved_at: 0, tabs: null } }); }
        }
        case "session_save":
          writeFileSync(SESSION, JSON.stringify({ clean_exit: false, saved_at: Date.now(), tabs: m.tabs, updated_to: null }));
          return reply(m.reqId);
        case "claude_account": return reply(m.reqId, { account: claudeAccount(m.dir) });
        case "claude_account_names": {
          try {
            return reply(m.reqId, {
              names: readdirSync(`${expand(m.dir)}/accounts`, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort(),
            });
          } catch { return reply(m.reqId, { names: [] }); }
        }
        case "claude_usage": return reply(m.reqId, { usage: claudeUsage(m.dir) });
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
// Dev twin of src-tauri/src/metrics.rs. Linux only, which is all the browser loop needs.
let lastCpu = os.cpus();
function hostMetrics() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i]?.times ?? c.times;
    for (const k of Object.keys(c.times)) total += c.times[k] - prev[k];
    idle += c.times.idle - prev.idle;
  });
  lastCpu = now;
  const fs = statfsSync("/");
  let swapTotal = 0, swapFree = 0;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    swapTotal = Number(/SwapTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) * 1024;
    swapFree = Number(/SwapFree:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) * 1024;
  } catch {}
  return {
    cpu: total > 0 ? ((total - idle) / total) * 100 : 0,
    mem_used: os.totalmem() - os.freemem(),
    mem_total: os.totalmem(),
    swap_used: swapTotal - swapFree,
    swap_total: swapTotal,
    disk_used: (fs.blocks - fs.bfree) * fs.bsize,
    disk_total: fs.blocks * fs.bsize,
    disk_name: "/",
  };
}

// Dev twin of src-tauri/src/claude.rs — same files, no incremental cache.
/** dev-config.json uses `~` so it carries no one's home directory. */
function expand(p) {
  return typeof p === "string" && p.startsWith("~") ? p.replace(/^~/, os.homedir()) : p;
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function claudeAccount(rawDir) {
  const dir = expand(rawDir);
  const account = { dir: rawDir, name: null, email: null, organization: null, tier: null, exists: false };
  try { statSync(dir); account.exists = true; } catch { return account; }
  try { account.name = readFileSync(`${dir}/accounts/current`, "utf8").trim() || null; } catch {}
  const p = (account.name && readJSON(`${dir}/accounts/${account.name}/account.json`)) ?? readJSON(`${dir}/.claude.json`);
  const o = p?.oauthAccount ?? p ?? {};
  account.email = o.emailAddress ?? null;
  account.organization = o.organizationName ?? null;
  account.tier = o.organizationRateLimitTier ?? o.userRateLimitTier ?? null;
  return account;
}

function claudeUsage(rawDir) {
  const dir = expand(rawDir);
  const now = Date.now();
  const empty = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0, billed: 0 });
  const usage = { dir: rawDir, window_5h: empty(), window_7d: empty(), last_activity: null, files_scanned: 0 };
  const seen = new Set();
  let dirs = [];
  try { dirs = readdirSync(`${dir}/projects`, { withFileTypes: true }); } catch { return usage; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(`${dir}/projects/${d.name}`)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = `${dir}/projects/${d.name}/${f}`;
      if (statSync(path).mtimeMs < now - 7 * 864e5) continue;
      usage.files_scanned++;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes('"usage"')) continue;
        let v; try { v = JSON.parse(line); } catch { continue; }
        const u = v.message?.usage;
        const id = v.message?.id ?? v.uuid;
        if (!u || !id || seen.has(id)) continue;
        seen.add(id);
        const ts = Date.parse(v.timestamp ?? "");
        if (!ts || ts < now - 7 * 864e5) continue;
        const billed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        for (const b of ts >= now - 5 * 36e5 ? [usage.window_7d, usage.window_5h] : [usage.window_7d]) {
          b.input += u.input_tokens ?? 0;
          b.output += u.output_tokens ?? 0;
          b.cache_read += u.cache_read_input_tokens ?? 0;
          b.cache_write += u.cache_creation_input_tokens ?? 0;
          b.messages++;
          b.billed += billed;
        }
        usage.last_activity = Math.max(usage.last_activity ?? 0, ts);
      }
    }
  }
  return usage;
}

console.log("OBPTerm dev-server: ws://0.0.0.0:1421 (config: dev-config.json)");
