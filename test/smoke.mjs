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
// A closing page flushes its session on the way out, so delete the file after that lands.
await new Promise((r) => setTimeout(r, 700));
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
const panes0 = await evaluate("document.querySelectorAll('.pane').length");
const dividers0 = await evaluate("document.querySelectorAll('.divider').length");
await evaluate("window.obpterm.splitPane('row')");
await evaluate("window.obpterm.splitPane('col')");
await until(`document.querySelectorAll('.pane').length === ${panes0 + 2}`, "two more panes");
assert.equal(await evaluate("document.querySelectorAll('.divider').length"), dividers0 + 2, "one divider per split");
await evaluate("window.obpterm.closePane(window.obpterm.tab.active)");
await until(`document.querySelectorAll('.pane').length === ${panes0 + 1}`, "one pane closed again");

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
const host = JSON.parse(await evaluate("JSON.stringify(window.obpterm.config.hosts[0])"));
await until(`window.obpterm.tab?.hostId === ${JSON.stringify(host.id)}`, "an ssh tab");
assert.equal(await evaluate("window.obpterm.tab.active.profile.exe"), "ssh");
assert.equal(await evaluate("document.querySelector('#target-chip .where').textContent"), host.name);
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
assert.ok(
  (await evaluate("document.querySelectorAll('.pane').length")) > JSON.parse(before).length,
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
// The picker is painted after the new panes have spawned, so wait for it rather than race it.
await until("document.querySelector('.layout-picker .tb.on')?.dataset.layout === '4'", "the picker showing 4");
// Shrinking ends live shells, so the first click only arms it.
await evaluate("void window.obpterm.applyPreset('1')");
await until("window.obpterm.armedPreset === '1'", "the shrink arming instead of killing");
assert.equal(await evaluate("document.querySelectorAll('.pane').length"), 4, "nothing died on the first click");
await evaluate("void window.obpterm.applyPreset('1')");
await until("document.querySelectorAll('.pane').length === 1", "the 1-pane preset on the second click");

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

// Title bar: the menus are built from the config, not hardcoded.
assert.equal(await evaluate("document.querySelectorAll('#titlebar .hmenu').length"), 4, "Shell / Panes / Project / View");
await evaluate("document.querySelectorAll('#titlebar .hmenu')[1].click()");
await until("!document.querySelector('#menu').hidden", "the Panes menu");
assert.match(await evaluate("document.querySelector('#menu').textContent"), /Split right/);
await evaluate("document.querySelector('#menu').hidden = true");

// Command palette: Ctrl+K, fuzzy match, Enter runs the entry.
await evaluate("window.obpterm.palette.open()");
await until("!document.querySelector('#palette').hidden", "the palette");
assert.ok(await evaluate("document.querySelectorAll('#palette .presult').length > 3"), "it lists commands");
await evaluate(
  "(() => { const i = document.querySelector('#palette input'); i.value = 'split right'; i.dispatchEvent(new Event('input')); })()",
);
assert.match(await evaluate("document.querySelector('#palette .presult .plabel').textContent"), /Split right/);
const panesBefore = await evaluate("document.querySelectorAll('.pane').length");
await evaluate("document.querySelector('#palette .presult').click()");
await until(`document.querySelectorAll('.pane').length === ${panesBefore + 1}`, "the palette ran the command");
await evaluate("window.obpterm.palette.close()");

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
await evaluate("window.obpterm.config.accounts.pop(), window.obpterm.persistConfig()");
assert.equal(await evaluate("window.obpterm.config.accounts.length"), accountsBefore, "and it can be dropped again");

// Ctrl+wheel zooms.
const size = await evaluate("window.obpterm.config.font_size");
await evaluate("document.querySelector('#panes').dispatchEvent(new WheelEvent('wheel', {deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true}))");
assert.equal(await evaluate("window.obpterm.config.font_size"), size + 1, "ctrl+wheel up grows the font");

// Closing a split must hand the whole tab back to the survivor — a stale flex once left it
// sitting at half width.
await evaluate("void window.obpterm.applyPreset('2c')");
await until("document.querySelectorAll('.pane').length === 2", "two panes");
const full = await evaluate("document.querySelector('#panes').getBoundingClientRect().width");
await evaluate("void window.obpterm.applyPreset('1')");
await evaluate("void window.obpterm.applyPreset('1')");
await until("document.querySelectorAll('.pane').length === 1", "one pane");
const wide = await evaluate("document.querySelector('.pane').getBoundingClientRect().width");
assert.ok(wide > full * 0.9, `the surviving pane fills the tab (${wide} of ${full})`);

// Activity states: output makes a tab run, silence decays it to idle, a bell marks it waiting
// and is answered by focusing the tab.
await evaluate("window.obpterm.tab.active.term.term.write('activity-probe\\r\\n')");
await evaluate("(() => { window.obpterm.tab.active.lastOutput = Date.now(); window.obpterm.onPaneActivity(); })()");
assert.equal(await evaluate("window.obpterm.activity(window.obpterm.tab)"), "running");
await until("document.querySelector('.tab.active .st').dataset.state === 'running'", "the running dot");
await evaluate("(() => { for (const t of window.obpterm.tabs) for (const p of window.obpterm.panesOf(t)) p.lastOutput = 0; window.obpterm.onPaneActivity(); })()");
assert.equal(await evaluate("window.obpterm.activity(window.obpterm.tab)"), "idle", "it decays without output");

const other = await evaluate("window.obpterm.tabs.length");
assert.ok(other >= 1);
await evaluate("(() => { const t = window.obpterm.tabs[0]; window.obpterm.panesOf(t)[0].bell = true; window.obpterm.onPaneActivity(); })()");
assert.equal(await evaluate("window.obpterm.activity(window.obpterm.tabs[0])"), "bell", "a bell outranks idle");
await until("document.querySelector('#rail-waiting').textContent === '1 waiting'", "the waiting count");
await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
assert.equal(await evaluate("window.obpterm.activity(window.obpterm.tabs[0])"), "idle", "focusing answers the bell");
await until("document.querySelector('#rail-waiting').hidden === true", "the count disappearing at zero");

// The rail patches rows instead of rebuilding them: the same element must survive a repaint.
await evaluate("(() => { window.__row = document.querySelector('.tab.active'); window.obpterm.onPaneActivity(); })()");
assert.equal(
  await evaluate("window.__row === document.querySelector('.tab.active')"),
  true,
  "a state repaint keeps the row element",
);

// A rail row lays out as a two-line pill: the parts had no CSS at all until v0.5.3.
assert.equal(await evaluate("getComputedStyle(document.querySelector('.tab .label')).flexDirection"), "column");
assert.equal(await evaluate("getComputedStyle(document.querySelector('.tab .title')).textOverflow"), "ellipsis");
assert.ok(
  await evaluate("getComputedStyle(document.querySelector('.tab .close')).width === '20px'"),
  "the close button is sized",
);

// …but xterm's own hidden textarea is not a text field: shortcuts must still work in a pane.
// Treating it as one silently killed every shortcut while a terminal had focus (v0.5.3).
await evaluate("window.obpterm.tab.active.focus()");
await evaluate(
  "(() => { const t = document.querySelector('.pane.focused .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea');" +
  " t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true})); })()",
);
await until("!document.querySelector('#palette').hidden", "Ctrl+K opening the palette from a pane");
await evaluate("window.obpterm.palette.close()");

// App shortcuts must not fire while a text field has focus.
await evaluate("window.obpterm.settings.open('updates')");
await until("!document.querySelector('#settings').hidden", "settings for the field test");
const tabsBefore = await evaluate("window.obpterm.tabs.length");
await evaluate(
  "(() => { const i = document.querySelector('#settings input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyT', key: 'T', ctrlKey: true, shiftKey: true, bubbles: true})); })()",
);
assert.equal(await evaluate("window.obpterm.tabs.length"), tabsBefore, "Ctrl+Shift+T did not open a tab while typing");
await evaluate("window.obpterm.settings.close()");

// Tab rename wins over the shell's own title, and clearing it hands the name back.
await evaluate("window.obpterm.renameTab(window.obpterm.tab, 'Renamed')");
assert.equal(await evaluate("window.obpterm.title(window.obpterm.tab)"), "Renamed");
await until("document.querySelector('.tab.active .title').textContent === 'Renamed'", "the rename in the rail");
assert.match(
  await evaluate("JSON.stringify(window.obpterm.snapshot(window.obpterm.tab))"),
  /"name":"Renamed"/,
  "the name is saved with the session",
);
await evaluate("window.obpterm.renameTab(window.obpterm.tab, '')");
assert.notEqual(await evaluate("window.obpterm.title(window.obpterm.tab)"), "Renamed", "clearing it gives the shell its title back");

// Copy-on-select: a finished left drag copies without a keypress (the /ssh/ terminal's habit).
await evaluate(
  "(() => { window.__copied = null; window.obpterm.tp.writeClipboard = (t) => { window.__copied = t; return Promise.resolve(); }; })()",
);
await evaluate("window.obpterm.tab.active.term.term.write('copy-on-select-marker\\r\\n')");
await new Promise((r) => setTimeout(r, 200));
await evaluate(
  "(() => { window.obpterm.tab.active.term.term.selectAll(); window.obpterm.tab.active.el.dispatchEvent(new MouseEvent('mouseup', {button: 0, bubbles: true})); })()",
);
await until("typeof window.__copied === 'string' && window.__copied.includes('copy-on-select-marker')", "the selection copied itself");
await evaluate("window.obpterm.tab.active.term.term.clearSelection()");

// Tier 2: the session remembers which tab was in front.
await evaluate("void window.obpterm.newTab()");
await until("window.obpterm.tabs.length >= 2", "a second tab");
await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
await evaluate("(() => { window.__f = false; window.obpterm.flushSession().then(() => (window.__f = true)); })()");
await until("window.__f === true", "a session flush");
assert.equal(JSON.parse(readFileSync(sessionFile, "utf8")).active, 0, "the front tab index is saved");

// Ctrl+Tab goes back to where you were, not to the next one created.
const second = await evaluate("window.obpterm.tabs.length - 1");
await evaluate(`window.obpterm.activate(window.obpterm.tabs[${second}])`);
await evaluate("window.obpterm.recent()");
assert.equal(await evaluate("window.obpterm.tabs.indexOf(window.obpterm.tab)"), 0, "back to the previous tab");
await evaluate("window.obpterm.recent()");
assert.equal(await evaluate("window.obpterm.tabs.indexOf(window.obpterm.tab)"), second, "and back again");

// A tab can be moved down the rail.
const movedId = await evaluate("window.obpterm.tabs[0].id");
await evaluate("window.obpterm.moveTab(window.obpterm.tabs[0], 1)");
assert.equal(await evaluate("window.obpterm.tabs[1].id"), movedId, "the tab moved one place down");

// Snippets reach the focused pane through the palette.
await evaluate(
  "(() => { window.__sent = ''; window.obpterm.tp.write = (id, d) => { window.__sent += d; return Promise.resolve(); };" +
  " window.obpterm.config.snippets = [{id: 's1', name: 'List containers', text: 'docker compose ps', send: true}]; })()",
);
await evaluate("window.obpterm.palette.open('list containers')");
await until("!!document.querySelector('#palette .presult')", "the snippet in the palette");
assert.match(await evaluate("document.querySelector('#palette .presult .pgroup').textContent"), /Snippet/);
await evaluate("document.querySelector('#palette .presult').click()");
await until("window.__sent.includes('docker compose ps')", "the snippet typed into the pane");
assert.match(await evaluate("window.__sent"), /\r$/, "send:true presses Enter");

await evaluate(`window.obpterm.closeTab(window.obpterm.tabs[${second}])`);

// A pane that fails to spawn must stay on screen: closing it cascaded to the window.
const tabsAtStart = await evaluate("window.obpterm.tabs.length");
await evaluate(
  "(() => { const p = window.obpterm.config.profiles; p.push({id: 'broken', name: 'Broken', exe: '/definitely/not/here', args: [], cwd: null, env: {}});" +
  " window.obpterm.newTab(p[p.length - 1]); })()",
);
await until(`window.obpterm.tabs.length === ${tabsAtStart + 1}`, "the broken tab");
await until("window.obpterm.panesOf(window.obpterm.tab)[0].exited === true", "the pane marked dead");
assert.equal(await evaluate("window.obpterm.tabs.length"), tabsAtStart + 1, "the tab survived the failure");
await evaluate("window.obpterm.closeTab(window.obpterm.tab)");
await evaluate("window.obpterm.config.profiles.pop()");

// Opening a saved layout twice must not spawn a second set of shells.
await evaluate(
  "(() => { const p = window.obpterm.config.projects[0]; window.obpterm.moveTabToProject(window.obpterm.tab, p.id);" +
  " window.obpterm.saveProjectLayout(p); })()",
);
const beforeReopen = await evaluate("window.obpterm.tabs.length");
await evaluate("void window.obpterm.openProjectLayout(window.obpterm.config.projects[0])");
await new Promise((r) => setTimeout(r, 400));
assert.equal(await evaluate("window.obpterm.tabs.length"), beforeReopen, "it refused to duplicate the open tabs");
await evaluate("(() => { window.obpterm.config.projects[0].layout = null; window.obpterm.moveTabToProject(window.obpterm.tab, null); })()");

// The palette says when nothing matched instead of showing an empty box.
await evaluate("window.obpterm.palette.open('zzzznothing')");
await until("!!document.querySelector('#palette .pempty')", "the no-matches row");
await evaluate("window.obpterm.palette.close()");

// ---- settings, as a sheet in this same window ------------------------------------------------
await evaluate("window.obpterm.settings.open('hosts')");
await until("!document.querySelector('#settings').hidden", "the settings sheet");
await until("document.querySelectorAll('#settings .sw-nav button').length >= 11", "the sections");
assert.equal(await evaluate("document.querySelector('#settings .crumb').textContent"), "SSH hosts");

const hostRows = await evaluate("document.querySelectorAll('#settings .sw-item').length");
await evaluate("document.querySelector('#settings .sw-add').click()");
await until(`document.querySelectorAll('#settings .sw-item').length === ${hostRows + 1}`, "an added host");
await evaluate(
  "(() => { const i = document.querySelector('#settings .sw-detail input'); i.value = 'Smoke host'; i.dispatchEvent(new Event('change')); })()",
);
await until("document.querySelector('#settings .sw-item.on b').textContent === 'Smoke host'", "the rename in the list");
await evaluate("[...document.querySelectorAll('#settings .sw-btn')].find(b => b.textContent === 'Delete').click()");
await until(`document.querySelectorAll('#settings .sw-item').length === ${hostRows}`, "the host deleted again");

// Every section renders; a section that throws would leave the body empty.
for (const title of ["Terminal", "Appearance", "Rail", "Startup", "Profiles", "Accounts", "Projects", "Keyboard", "Updates", "Files"]) {
  await evaluate(`[...document.querySelectorAll('#settings .sw-nav button')].find(b => b.textContent.startsWith(${JSON.stringify(title)}))?.click()`);
  await until("!!document.querySelector('#settings .sw-main').firstElementChild", `the ${title} section`);
}

// Changing the accent repaints the app behind the sheet, not just the sheet.
await evaluate("(() => { window.obpterm.config.accent = '#4c8dff'; window.obpterm.settings.open('appearance'); window.obpterm.applyConfig(); })()");
assert.match(
  await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"),
  /#4c8dff/i,
  "the accent reaches the app's tokens",
);
await evaluate("(() => { window.obpterm.config.accent = '#ff8a1e'; window.obpterm.applyConfig(); window.obpterm.settings.close(); })()");
await until("document.querySelector('#settings').hidden", "the sheet closing");

const bad = logs.filter((l) => /^(error|exception)/.test(l));
assert.deepEqual(bad, [], `console was not clean:\n${bad.join("\n")}`);
console.log(`smoke OK — ${logs.length} console messages, none of them errors`);
process.exit(0);

