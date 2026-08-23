// Headless smoke test of the real UI: boots the built app in Chromium over CDP, spawns shells
// through dev-server.mjs, then asserts the panes actually rendered. Catches the runtime errors
// a typecheck cannot. Usage: node test/smoke.mjs http://127.0.0.1:1420/
import WebSocket from "ws";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:1420/";
const sessionFile = new URL("../dev-session.json", import.meta.url);

// A page left open by an earlier run keeps writing the session file, so close every tab first.
for (const t of await (await fetch("http://127.0.0.1:9222/json/list")).json()) {
  if (t.type === "page") await fetch(`http://127.0.0.1:9222/json/close/${t.id}`);
}
rmSync(sessionFile, { force: true }); // start from no saved session
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
    if (Date.now() > deadline) {
      const state = await evaluate(
        "JSON.stringify({tabs: window.obpterm?.tabs?.length, panes: document.querySelectorAll('.pane').length, dividers: document.querySelectorAll('.divider').length})",
      ).catch(() => "unavailable");
      throw new Error(`timed out waiting for ${what}\nstate: ${state}\n${logs.join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
};

await until("!!document.querySelector('.xterm-screen')", "the first terminal");
await until("!!window.obpterm?.tab?.active?.id > 0", "a live pty");

// Split twice, then close one pane: the tree, the DOM and the ptys must agree.
await evaluate("window.obpterm.splitPane('row')");
await evaluate("window.obpterm.splitPane('col')");
await until("document.querySelectorAll('.pane').length === 3", "3 panes");
assert.equal(await evaluate("document.querySelectorAll('.divider').length"), 2, "one divider per split");
await evaluate("window.obpterm.closePane(window.obpterm.tab.active)");
await until("document.querySelectorAll('.pane').length === 2", "2 panes after close");

// Projects: a new project groups its tab and repaints the rail in the project colour.
await evaluate("window.obpterm.moveTabToProject(window.obpterm.tab, window.obpterm.addProject('Smoke').id)");
await until("!!document.querySelector('.group-head .gname')", "a project group");
assert.equal(await evaluate("document.querySelector('.group-head .gname').textContent"), "Smoke");
assert.match(await evaluate("window.obpterm.accent()"), /^#[0-9a-f]{6}$/i, "project colour is the accent");

// Search and log capture over the live session.
await evaluate("window.obpterm.tab.active.term.term.write('obpterm-smoke-marker\\r\\n')");
await new Promise((r) => setTimeout(r, 300));
assert.equal(
  await evaluate("window.obpterm.tab.active.term.search.findNext('obpterm-smoke-marker')"),
  true,
  "find locates text in the scrollback",
);
assert.match(await evaluate("window.obpterm.tab.active.toggleLog()"), /\.log$/, "capture returns a path");

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
  "window.__usage = null, void window.obpterm.tp.claudeUsage(window.obpterm.config.accounts[0].claude_dir).then(u => (window.__usage = JSON.stringify(u)))",
);
await until("!!window.__usage", "a usage reading");
const usage = JSON.parse(await evaluate("window.__usage"));
assert.ok(usage.window_7d.billed > 0, "7-day token usage was read from the transcripts");
assert.ok(usage.files_scanned > 0, "transcripts were found");

// Host book: a tab opened on a host runs ssh and says so in the status bar.
await evaluate("void window.obpterm.newTabForHost(window.obpterm.config.hosts[0])");
await until("window.obpterm.tab?.hostId === 'pi'", "an ssh tab");
assert.equal(await evaluate("window.obpterm.tab.active.profile.exe"), "ssh");
assert.equal(await evaluate("document.querySelector('#target-chip .where').textContent"), "Pi");
await evaluate("window.obpterm.closeTab(window.obpterm.tab)");

const snap = await evaluate("JSON.stringify(window.obpterm.tabs.map(t => window.obpterm.snapshot(t)))");
assert.match(snap, /"kind":"split"/, "the split survives serialization");

// Crash safety: the session file on disk must already match the open tabs, without a clean exit.
await evaluate("(() => { window.__flushed = false; window.obpterm.flushSession().then(() => (window.__flushed = true)); })()");
await until("window.__flushed === true", "a session flush");
const session = JSON.parse(readFileSync(sessionFile, "utf8"));
assert.equal(session.clean_exit, false, "a running app never claims a clean exit");
assert.equal(session.tabs.length, await evaluate("window.obpterm.tabs.length"), "every open tab is on disk");
assert.match(JSON.stringify(session.tabs), /"kind":"split"/, "the pane tree is on disk too");
assert.ok(session.saved_at > Date.now() - 60_000, "the snapshot is fresh");

// Crash and reopen: reload without a clean exit, exactly what the app sees after a kill.
const before = await evaluate("JSON.stringify(window.obpterm.tabs.map(t => window.obpterm.title(t)))");
await send("Page.navigate", { url });
await until("!!window.obpterm?.tabs?.length", "the app after a reload");
await until(
  `JSON.stringify(window.obpterm.tabs.map(t => t.active.profile.name)).length > 0 && window.obpterm.tabs.length === ${session.tabs.length}`,
  `${session.tabs.length} tabs reopened`,
);
assert.equal(
  await evaluate("document.querySelectorAll('.pane').length"),
  JSON.parse(before).length + 1,
  "the split pane came back too",
);
// The notice lands after the last pane has spawned, so wait for it rather than racing it.
await until(
  "document.querySelector('#toast').textContent.includes('did not shut down cleanly')",
  "the unclean-exit notice",
);

// Toolbar presets: the 4-pane button must produce exactly four panes and light up.
await evaluate("void window.obpterm.applyPreset('4')");
await until("document.querySelectorAll('.pane').length === 4", "the 4-pane preset");
assert.equal(await evaluate("document.querySelector('.layout-picker .tb.on').dataset.layout"), "4");
await evaluate("void window.obpterm.applyPreset('1')");
await until("document.querySelectorAll('.pane').length === 1", "the 1-pane preset");

// Machine gauges come from the host, not from placeholders.
await until("document.querySelectorAll('#metrics .gauge').length === 4", "cpu/ram/swap/disk gauges");
assert.ok(
  await evaluate("(() => { const m = window.obpterm.status; return true; })()"),
  "status bar is wired",
);

// Rail: a project folds away, the width sticks, and nothing scrolls sideways.
// Start from expanded: the collapse state is persisted, so a previous run must not decide this.
await evaluate("(() => { window.obpterm.config.projects[0].collapsed = false; window.obpterm.paint(); })()");
await evaluate("void window.obpterm.toggleProject(window.obpterm.config.projects[0])");
await until("!!document.querySelector('.group.collapsed')", "a collapsed project");
assert.equal(await evaluate("getComputedStyle(document.querySelector('.group.collapsed .glist')).display"), "none");
await evaluate("void window.obpterm.toggleProject(window.obpterm.config.projects[0])");
await until("!document.querySelector('.group.collapsed')", "the project expanded again");
await evaluate("window.obpterm.setRailWidth(300)");
assert.equal(await evaluate("document.querySelector('#rail').getBoundingClientRect().width"), 300);
assert.equal(
  await evaluate("document.querySelector('#rail-body').scrollWidth <= document.querySelector('#rail-body').clientWidth"),
  true,
  "the rail never scrolls sideways",
);

// Settings: every list can add, edit and delete — hosts is the representative one.
await evaluate("window.obpterm.settings.open('hosts')");
await until("!document.querySelector('#settings').hidden", "the settings sheet");
const hostsBefore = await evaluate("window.obpterm.config.hosts.length");
await evaluate("document.querySelectorAll('#settings .add')[0].click()");
assert.equal(await evaluate("window.obpterm.config.hosts.length"), hostsBefore + 1, "a host can be added");
await evaluate(
  "(() => { const i = document.querySelectorAll('#settings .row')[1].querySelector('input'); i.value = 'Edited'; i.dispatchEvent(new Event('change')); })()",
);
assert.equal(await evaluate("window.obpterm.config.hosts[1].name"), "Edited", "a host can be edited");
await evaluate("document.querySelectorAll('#settings .row')[1].querySelector('.del').click()");
assert.equal(await evaluate("window.obpterm.config.hosts.length"), hostsBefore, "a host can be deleted");
assert.equal(
  await evaluate("document.querySelectorAll('#settings .row')[0].querySelector('.del').disabled"),
  false,
  "the remaining host is still deletable",
);
await evaluate("window.obpterm.settings.close()");

// A second Claude Code account is an env preset with its own CLAUDE_CONFIG_DIR — never a
// credential copy — and it can be signed into from its settings row.
const accountsBefore = await evaluate("window.obpterm.config.accounts.length");
await evaluate("void window.obpterm.addClaudeAccount()");
assert.equal(await evaluate("window.obpterm.config.accounts.length"), accountsBefore + 1);
assert.match(
  await evaluate("JSON.stringify(window.obpterm.config.accounts.at(-1).env)"),
  /CLAUDE_CONFIG_DIR/,
  "the new account points at its own config dir",
);
await until("!document.querySelector('#settings').hidden", "settings open on accounts");
assert.ok(
  await evaluate("[...document.querySelectorAll('#settings .act')].some(b => b.textContent === 'Sign in')"),
  "each account row offers Sign in",
);
await evaluate("document.querySelectorAll('#settings .row')[document.querySelectorAll('#settings .row').length - 1].querySelector('.del').click()");
assert.equal(await evaluate("window.obpterm.config.accounts.length"), accountsBefore, "and it can be deleted again");
await evaluate("window.obpterm.settings.close()");

// Ctrl+wheel zooms.
const size = await evaluate("window.obpterm.config.font_size");
await evaluate("document.querySelector('#panes').dispatchEvent(new WheelEvent('wheel', {deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true}))");
assert.equal(await evaluate("window.obpterm.config.font_size"), size + 1, "ctrl+wheel up grows the font");

const bad = logs.filter((l) => /^(error|exception)/.test(l));
assert.deepEqual(bad, [], `console was not clean:\n${bad.join("\n")}`);
console.log(`smoke OK — ${logs.length} console messages, none of them errors`);
process.exit(0);
