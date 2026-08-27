// Browser dev loop for the UI: real shells via node-pty behind a WebSocket on :1421.
// Usage: `npm run devserver` here, `npm run dev` in another shell, open http://<host>:1420.
// Protocol mirrors transport-ws.ts; config lives in ./dev-config.json.
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";

const CONFIG = new URL("./dev-config.json", import.meta.url);
const SESSION = new URL("./dev-session.json", import.meta.url);
// Loopback only: this server spawns whatever executable a client names, so it must not be
// reachable from the network. Set OBPTERM_DEV_HOST to drive it from another machine.
const wss = new WebSocketServer({ port: 1421, host: process.env.OBPTERM_DEV_HOST ?? "127.0.0.1" });
let nextId = 1;

// The dev server plays the session host: ptys live here, across page reloads, with a ring of
// what each printed, so the browser loop can prove reattach the way the real host does.
const INSTANCE = Math.random().toString(36).slice(2, 10);
const RING = 1024 * 1024;
const held = new Map();
const answered = []; // id -> { p, exe, cwd, ring: Buffer[], ringBytes, exited, startedAt, watcher }

const broadcast = (msg) => {
  for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify(msg));
};

wss.on("connection", (ws) => {
  const logs = new Map();
  const reply = (reqId, body = {}) => ws.send(JSON.stringify({ reqId, ...body }));
  const watching = new Set();
  const frame = (id, d) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(id);
    return Buffer.concat([head, Buffer.from(d)]);
  };
  const watch = (id) => {
    const s = held.get(id);
    if (!s) return;
    watching.add(id);
    s.watcher = (d) => ws.readyState === ws.OPEN && ws.send(frame(id, d));
    s.onExit = (code) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "exit", id, code }));
  };

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    try {
      switch (m.t) {
        case "host_info": return reply(m.reqId, { info: { instance: INSTANCE, version: "dev", connected: true } });
        case "list":
          return reply(m.reqId, {
            sessions: [...held.entries()].map(([id, s]) => ({
              id, exe: s.exe, cwd: s.cwd, attached: !!s.watcher, exited: s.exited, started_at: s.startedAt,
              last_output: s.lastOutput ?? s.startedAt, bell: !!s.bell,
            })),
          });
        case "attach": {
          const s = held.get(m.id);
          if (!s) return reply(m.reqId, { error: `no session ${m.id}` });
          reply(m.reqId);
          s.bell = false;
          for (const chunk of s.ring) ws.send(frame(m.id, chunk));
          watch(m.id);
          s.p?.resize(m.cols, m.rows);
          if (s.exited !== null) ws.send(JSON.stringify({ t: "exit", id: m.id, code: s.exited }));
          return;
        }
        case "detach": {
          const s = held.get(m.id);
          if (s) { s.watcher = null; s.onExit = null; }
          watching.delete(m.id);
          return reply(m.reqId);
        }
        case "shutdown":
          for (const s of held.values()) s.p?.kill();
          held.clear();
          return reply(m.reqId);
        case "spawn": {
          const { profile, cols, rows } = m;
          const p = pty.spawn(profile.exe, profile.args ?? [], {
            name: "xterm-256color",
            cols, rows,
            cwd: expand(profile.cwd) ?? os.homedir(),
            env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", OBPTERM: "dev" },
          });
          const id = nextId++;
          const s = { p, exe: profile.exe, cwd: profile.cwd ?? null, ring: [], ringBytes: 0, exited: null, startedAt: Date.now(), watcher: null, onExit: null };
          held.set(id, s);
          p.onData((d) => {
            const buf = Buffer.from(d);
            s.lastOutput = Date.now();
            if (!s.watcher && buf.includes(7)) s.bell = true;
            s.ring.push(buf);
            s.ringBytes += buf.length;
            while (s.ringBytes > RING && s.ring.length > 1) s.ringBytes -= s.ring.shift().length;
            logs.get(id)?.write(d);
            s.watcher?.(d);
          });
          p.onExit(({ exitCode }) => {
            s.exited = exitCode;
            s.p = null;
            logs.get(id)?.end();
            logs.delete(id);
            s.onExit?.(exitCode);
          });
          watch(id);
          return reply(m.reqId, { id });
        }
        case "write": held.get(m.id)?.p?.write(m.data); return reply(m.reqId);
        case "resize": held.get(m.id)?.p?.resize(m.cols, m.rows); return reply(m.reqId);
        case "kill": {
          const s = held.get(m.id);
          s?.p?.kill();
          held.delete(m.id);
          return reply(m.reqId);
        }
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
          writeFileSync(SESSION, JSON.stringify({ clean_exit: false, saved_at: Date.now(), tabs: m.tabs, active: m.active ?? 0, host: m.host ?? null, updated_to: null }));
          return reply(m.reqId);
        case "logins": return reply(m.reqId, { logins: devLogins(m.action, m.name) });
        case "agent_inject": {
          // Test-only: pretend a hook fired. The real path is Claude Code -> host HTTP.
          broadcast({ t: "agent", update: m.update });
          return reply(m.reqId);
        }
        case "agent_answer": {
          answered.push({ pending: m.pending, allow: m.allow });
          broadcast({ t: "agent_answered", pending: m.pending, allow: m.allow });
          return reply(m.reqId);
        }
        case "agent_answers": return reply(m.reqId, { answered });
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
        case "config_save":
          writeFileSync(CONFIG, JSON.stringify(m.config, null, 2) + "\n");
          broadcast({ t: "config:changed" });
          return reply(m.reqId);
        case "config_reset": return reply(m.reqId, { config: JSON.parse(readFileSync(CONFIG, "utf8")) });
        default: return reply(m.reqId, { error: `unknown message ${m.t}` });
      }
    } catch (e) {
      reply(m.reqId, { error: String(e) });
    }
  });
  // The window went away: its shells keep running, just unwatched — the host's contract.
  ws.on("close", () => {
    for (const id of watching) {
      const s = held.get(id);
      if (s) { s.watcher = null; s.onExit = null; }
    }
  });
});
// Dev twin of the login switcher: an in-memory profile set, the same refusals.
const devProfiles = { current: "personal", live: "ozanberkplt@gmail.com", accounts: { personal: "ozanberkplt@gmail.com", is: "platform@d724cloud.com" } };
function devLogins(action, name) {
  if (action === "save" && name) { devProfiles.accounts[name] = devProfiles.live; devProfiles.current = name; }
  if (action === "switch" && name) {
    if (!devProfiles.accounts[name]) throw new Error(`no such profile: ${name}`);
    devProfiles.current = name; devProfiles.live = devProfiles.accounts[name];
  }
  if (action === "forget" && name) { delete devProfiles.accounts[name]; if (devProfiles.current === name) devProfiles.current = null; }
  return {
    accounts: Object.entries(devProfiles.accounts).map(([n, email]) => ({ name: n, email })).sort((a, b) => a.name.localeCompare(b.name)),
    current: devProfiles.current, email: devProfiles.live, running: 0, file_backed: true,
  };
}

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

console.log("OBPTerm dev-server: ws://127.0.0.1:1421 (config: dev-config.json)");
