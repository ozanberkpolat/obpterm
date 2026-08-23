// Headless smoke test of the real UI: boots the built app in Chromium over CDP, spawns shells
// through dev-server.mjs, then asserts the panes actually rendered. Catches the runtime errors
// a typecheck cannot. Usage: node test/smoke.mjs http://127.0.0.1:1420/
import WebSocket from "ws";
import assert from "node:assert/strict";

const url = process.argv[2] ?? "http://127.0.0.1:1420/";
const target = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const logs = [];
let seq = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
  if (m.method === "Runtime.consoleAPICalled")
    logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (m.method === "Runtime.exceptionThrown")
    logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
});

await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url });

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

const until = async (expr, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await evaluate(expr).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

await until("!!document.querySelector('.xterm-screen')", "the first terminal");
await until("!!window.winterm?.tab?.active?.id > 0", "a live pty");

// Split twice, then close one pane: the tree, the DOM and the ptys must agree.
await evaluate("window.winterm.splitPane('row')");
await evaluate("window.winterm.splitPane('col')");
await until("document.querySelectorAll('.pane').length === 3", "3 panes");
assert.equal(await evaluate("document.querySelectorAll('.divider').length"), 2, "one divider per split");
await evaluate("window.winterm.closePane(window.winterm.tab.active)");
await until("document.querySelectorAll('.pane').length === 2", "2 panes after close");

// Projects: a new project groups its tab and repaints the rail in the project colour.
await evaluate("window.winterm.moveTabToProject(window.winterm.tab, window.winterm.addProject('Smoke').id)");
await until("!!document.querySelector('.group-head .gname')", "a project group");
assert.equal(await evaluate("document.querySelector('.group-head .gname').textContent"), "Smoke");
assert.match(await evaluate("window.winterm.accent()"), /^#[0-9a-f]{6}$/i, "project colour is the accent");

// Search and log capture over the live session.
await evaluate("window.winterm.tab.active.term.term.write('winterm-smoke-marker\\r\\n')");
await new Promise((r) => setTimeout(r, 300));
assert.equal(
  await evaluate("window.winterm.tab.active.term.search.findNext('winterm-smoke-marker')"),
  true,
  "find locates text in the scrollback",
);
assert.match(await evaluate("window.winterm.tab.active.toggleLog()"), /\.log$/, "capture returns a path");

// A saved session round-trips through the same code the app restores from.
// Status bar: the account chip and the token meters come from Claude Code's own files.
await until("document.querySelector('#account-chip .who').textContent !== '—'", "the account chip");
const who = await evaluate("document.querySelector('#account-chip .who').textContent");
assert.notEqual(who, "no account configured", "the default account resolved");
const meter = await evaluate("document.querySelector('.meter[data-window=\"5h\"] .val').textContent");
assert.match(meter, /^5h /, `quota meter shows a value, got ${meter}`);
// Read it through the page's own transport, parking the result on window: CDP refuses to
// serialize the promise chain directly.
await evaluate(
  "window.__usage = null, void window.winterm.tp.claudeUsage(window.winterm.config.accounts[0].claude_dir).then(u => (window.__usage = JSON.stringify(u)))",
);
await until("!!window.__usage", "a usage reading");
const usage = JSON.parse(await evaluate("window.__usage"));
assert.ok(usage.window_7d.billed > 0, "7-day token usage was read from the transcripts");
assert.ok(usage.files_scanned > 0, "transcripts were found");

// Host book: a tab opened on a host runs ssh and says so in the status bar.
await evaluate("void window.winterm.newTabForHost(window.winterm.config.hosts[0])");
await until("window.winterm.tab?.hostId === 'pi'", "an ssh tab");
assert.equal(await evaluate("window.winterm.tab.active.profile.exe"), "ssh");
assert.equal(await evaluate("document.querySelector('#target-chip .where').textContent"), "Pi");
await evaluate("window.winterm.closeTab(window.winterm.tab)");

const snap = await evaluate("JSON.stringify(window.winterm.tabs.map(t => window.winterm.snapshot(t)))");
assert.match(snap, /"kind":"split"/, "the split survives serialization");

const bad = logs.filter((l) => /^(error|exception)/.test(l));
assert.deepEqual(bad, [], `console was not clean:\n${bad.join("\n")}`);
console.log(`smoke OK — ${logs.length} console messages, none of them errors`);
process.exit(0);
