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
// Headless has no real focus; without this, document.hasFocus() is false and every
// "focused pane" behaviour (read-on-watch, auto-pass) looks broken when it is not.
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
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

// The session host: a shell started by this window must still be there, with its output,
// for the next window. Print a marker, drop the page, come back, and expect to read it.
await evaluate("window.obpterm.tab.active.term.term.write('')");
await evaluate("void window.obpterm.tp.write(window.obpterm.tab.active.id, 'echo survived-the-window\\n')");
// Joined, not per line: a narrow pane wraps the marker across several rows.
const bufferText = (expr) =>
  `(() => { const b = ${expr}.term.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i)?.translateToString(true) ?? ''; return t; })()`;
await until(`${bufferText("window.obpterm.tab.active")}.includes('survived-the-window')`, "the marker on screen");
const heldId = await evaluate("window.obpterm.tab.active.id");
await evaluate("(() => { window.__f = false; window.obpterm.flushSession().then(() => (window.__f = true)); })()");
await until("window.__f === true", "the session flushed with the pty id");
assert.match(readFileSync(sessionFile, "utf8"), new RegExp(`"pty":${heldId}`), "the pty id is in the session");

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
// With a host, coming back is not a crash recovery: the shells never stopped.
await until("window.obpterm.reattached > 0", "a pane reattached to its surviving shell");
assert.ok(
  await evaluate(`window.obpterm.tabs.some(t => window.obpterm.panesOf(t).some(p => p.id === ${heldId}))`),
  "the same host session id is behind a pane again",
);
await until(
  `${bufferText(`window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${heldId})`)}.includes('survived-the-window')`,
  "the replayed history in the new terminal",
);
await until("document.querySelector('#toast').textContent.includes('never stopped')", "the reattach notice");


// Reboot: the host instance in the session file is stale, and claude had been TYPED into a
// plain shell — the restore must TYPE `claude --resume` into the new shell, not hand
// --resume to the shell's own args (the v0.10.0 bug that errored every restored pane).
await evaluate("window.obpterm.tab.active.claudeSessionId = 'sess-reboot-1'");
await evaluate("window.obpterm.hostInstance = 'rebooted-instance'");
await evaluate("(() => { window.__rb = false; window.obpterm.flushSession().then(() => (window.__rb = true)); })()");
await until("window.__rb === true", "the session flushed with the stale instance");
await send("Page.navigate", { url });
await until("!!window.obpterm?.tabs?.length", "the app after the reboot");
await until(
  `${bufferText("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.claudeSessionId === 'sess-reboot-1')")}.includes('claude --resume sess-reboot-1')`,
  "the typed resume after a reboot",
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
// A run that died between collapse and expand leaves rail_collapsed behind — normalize first.
await evaluate("(() => { if (window.obpterm.config.rail_collapsed) window.obpterm.toggleRail(); })()");
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

// Ctrl+wheel zooms. Reset first: every run leaves the size one larger in dev-config.json.
await evaluate("window.obpterm.zoom(0)");
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
assert.notEqual(await evaluate("window.obpterm.activity(window.obpterm.tabs[0])"), "bell", "focusing answers the bell"); // idle, or running if the shell just printed
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

// Collapsed, every row is the same 30px circle and idle rows show no glyph.
await evaluate("(() => { window.obpterm.config.rail_collapsed = false; window.obpterm.toggleRail(); })()");
await until("document.querySelector('#rail').classList.contains('collapsed')", "the collapsed rail");
const box = JSON.parse(
  await evaluate("(() => { const r = document.querySelector('.tab').getBoundingClientRect(); return JSON.stringify([r.width, r.height]); })()"),
);
assert.deepEqual(box, [30, 30], "a collapsed row is a 30px circle");
await until("!!document.querySelector('.tab .st.idle')", "a row going idle"); // running decays 2s after the last byte
assert.equal(
  await evaluate("getComputedStyle(document.querySelector('.tab .st.idle')).display"),
  "none",
  "an idle glyph is hidden when collapsed",
);
await evaluate("window.obpterm.toggleRail()");
await until("!document.querySelector('#rail').classList.contains('collapsed')", "the rail expanded again");

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
  "(() => { window.__sent = ''; window.__realWrite = window.obpterm.tp.write; window.obpterm.tp.write = (id, d) => { window.__sent += d; return Promise.resolve(); };" +
  " window.obpterm.config.snippets = [{id: 's1', name: 'List containers', text: 'docker compose ps', send: true}]; })()",
);
await evaluate("window.obpterm.palette.open('list containers')");
await until("!!document.querySelector('#palette .presult')", "the snippet in the palette");
assert.match(await evaluate("document.querySelector('#palette .presult .pgroup').textContent"), /Snippet/);
await evaluate("document.querySelector('#palette .presult').click()");
await until("window.__sent.includes('docker compose ps')", "the snippet typed into the pane");
assert.match(await evaluate("window.__sent"), /\r$/, "send:true presses Enter");
await evaluate("window.obpterm.tp.write = window.__realWrite"); // everything after this writes to real shells again

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

// Sleep and wake: an unvisited pane loses its terminal, the host keeps the shell, and a click
// brings the terminal back with the shell's output. The rail keeps reporting on it meanwhile.
await evaluate("void window.obpterm.newTab()");
await until("window.obpterm.tabs.length >= 2", "a tab to put to sleep");
const sleeper = await evaluate("window.obpterm.tabs.length - 1");
await evaluate(`window.obpterm.activate(window.obpterm.tabs[${sleeper}])`);
await until(`window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].id > 0`, "its shell");
await evaluate(`void window.obpterm.tp.write(window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].id, 'echo before-sleep\\n')`);
await until(`${bufferText(`window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0]`)}.includes('before-sleep')`, "output before sleeping");
await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
await evaluate(`(() => { window.obpterm.config.sleep_after_minutes = 1; window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].lastVisited = 0; })()`);
await evaluate("void window.obpterm.sleepIdleTabs()");
await until(`window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].asleep === true`, "the pane asleep");
assert.equal(await evaluate(`window.obpterm.tabs[${sleeper}].el.querySelector('.xterm') === null`), true, "its terminal is gone");
assert.match(await evaluate("document.querySelector('#host-chip').textContent"), /1 asleep/, "the status bar says so");
// Output while asleep is the host's to report.
await evaluate(`void window.obpterm.tp.write(window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].id, 'printf "\\a"\\n')`);
await evaluate("void window.obpterm.refreshHeld()");
await until(`window.obpterm.activity(window.obpterm.tabs[${sleeper}]) === 'bell'`, "a bell seen by the host while asleep");
await evaluate(`window.obpterm.activate(window.obpterm.tabs[${sleeper}])`);
await until(`window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].asleep === false`, "the pane awake");
await until(`${bufferText(`window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0]`)}.includes('before-sleep')`, "the replay after waking");
await evaluate(`window.obpterm.closeTab(window.obpterm.tabs[${sleeper}])`);
await evaluate("window.obpterm.config.sleep_after_minutes = 10");

// ---- agent supervision: hook events drive the states, and answers travel back -------------
const agentPaneId = await evaluate("window.obpterm.tab.active.id");
// Drive the loop through the dev server's inject path with a raw ws from the test runner.
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });

  await injectDev({ pane: agentPaneId, state: "working", session_id: "sess-1", detail: "Editing pty.rs", pending_id: null, options: [] });
  await until(`window.obpterm.tab.active.agent.state === 'working'`, "the working state landing");
  assert.equal(await evaluate("window.obpterm.tab.active.claudeSessionId"), "sess-1", "the session id was learned");
  await until("document.querySelector('.tab.active .sub').textContent === 'Editing pty.rs'", "the activity line in the rail");

  // done while focused: not unread
  await injectDev({ pane: agentPaneId, state: "done", session_id: "sess-1", detail: "All tests pass.", pending_id: null, options: [] });
  await until(`window.obpterm.tab.active.agent.state === 'done'`, "the done state");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.unread"), false, "watched it finish = read");

  // blocked while focused: auto-pass, so the in-pane prompt is not delayed
  await injectDev({ pane: agentPaneId, state: "blocked", session_id: "sess-1", detail: "Running rm -rf build", pending_id: "p-77", options: [] });
  await new Promise((r) => setTimeout(r, 300));
  const answers = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 1000 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 1000) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(answers[0], { pending: "p-77", allow: null }, "a focused pane's request is passed straight through");

  // blocked on ANOTHER tab: stays blocked, counts as waiting, and Deny travels back
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second tab for the blocked case");
  const otherPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[0])[0].id");
  const blockedPane = agentPaneId === otherPane
    ? await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id")
    : otherPane;
  const focusTab = await evaluate(`window.obpterm.tabs.findIndex(t => window.obpterm.panesOf(t).some(p => p.id !== ${blockedPane}))`);
  await evaluate(`window.obpterm.activate(window.obpterm.tabs[${focusTab}])`);
  await injectDev({ pane: blockedPane, state: "blocked", session_id: "sess-2", detail: "Running cargo publish", pending_id: "p-88", options: [] });
  await until(
    `window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${blockedPane})?.agent.state === 'blocked'`,
    "the unfocused pane blocked",
  );
  await evaluate(
    `void window.obpterm.answerAgent(window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${blockedPane}), false)`,
  );
  const answers2 = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 1001 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 1001) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(answers2[1], { pending: "p-88", allow: false }, "the deny reached the host");
  devWs.close();
  // close the extra tab
  await evaluate(`(() => { const t = window.obpterm.tabs.find(t => window.obpterm.panesOf(t).some(p => p.id === ${blockedPane})); if (t && window.obpterm.tabs.length > 1) window.obpterm.closeTab(t); })()`);
}


// ---- the Agent Deck + the rail's Agents badge ---------------------------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  // The earlier block leaves its auto-passed pane blocked (nobody typed the in-pane answer);
  // start this one from silence so the counts are its own.
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; }), window.obpterm.paint()");
  // A blocked session on a tab the user is not looking at: the badge must say so.
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second tab for the deck case");
  const deckPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await injectDev({ pane: deckPane, state: "blocked", session_id: "sess-9", detail: "Running git push --tags", pending_id: "p-99", options: ["Yes", "No, ask again"] });
  await until("!document.querySelector('#rail-agents').hidden", "the Agents entry appearing");
  await until("document.querySelector('#rail-agents .abadge').textContent === '1'", "the waiting badge");
  assert.ok(await evaluate("document.querySelector('#rail-agents').classList.contains('alert')"), "the entry is loud");
  assert.ok(
    (await evaluate("document.querySelector('#rail-agents .asub').textContent")).includes("git push"),
    "the subtitle names the loudest hold",
  );

  // Ctrl+G at the terminal's own textarea opens the deck (ownsKey must claim it there too).
  await evaluate(
    "(document.querySelector('.tab-panes.active .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea')).dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', ctrlKey: true, bubbles: true, cancelable: true }))",
  );
  await until("window.obpterm.deck.isOpen", "the deck open on Ctrl+G");
  await until("document.querySelector('.dcard[data-state=blocked]') !== null", "the blocked card");
  assert.ok(
    (await evaluate("document.querySelector('.dcard[data-state=blocked] .dask .q').textContent")).includes("git push"),
    "the card carries the question",
  );
  assert.equal(await evaluate("document.querySelectorAll('.dcard[data-state=blocked] .opts li').length"), 2, "its options render");
  assert.ok((await evaluate("document.querySelector('#deck .dsummary .hot').textContent")).startsWith("1 need"), "the summary counts it");

  // Allow from the card: the verdict reaches the host and the card quiets down.
  await evaluate("document.querySelector('.dcard[data-state=blocked] .allow').click()");
  const deckAnswers = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 1002 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 1002) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(deckAnswers.at(-1), { pending: "p-99", allow: true }, "the deck's Allow reached the host");
  await until("document.querySelector('#rail-agents .abadge').hidden", "the badge cleared");

  // Clicking a card jumps to its pane; Escape closes the deck.
  await evaluate("window.obpterm.deck.open()");
  await evaluate("document.querySelector('.dcard').click()");
  await until("!window.obpterm.deck.isOpen", "the deck closed by the jump");
  assert.equal(await evaluate(`window.obpterm.panesOf(window.obpterm.tab)[0].id`), deckPane, "the jump landed on the card's tab");
  await evaluate("window.obpterm.deck.open()");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }))");
  await until("!window.obpterm.deck.isOpen", "the deck closed by Escape");

  devWs.close();
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
}




// ---- v0.14.0: deck keyboard, needs-you jump, duplicate tab, progress, find count ----------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second tab");
  const busyPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");

  // Ctrl+Shift+G jumps to the agent that waits.
  await injectDev({ pane: busyPane, state: "blocked", session_id: "sess-14", detail: "Running npm publish", pending_id: "p-140", options: [] });
  await until(`window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${busyPane})?.agent.state === 'blocked'`, "the blocked state");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'G', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
  await until(`window.obpterm.tab.active.id === ${busyPane}`, "the jump landing on the waiting pane");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");

  // The deck takes focus and answers from the keyboard: first card is the loudest, 'a' allows.
  await evaluate("window.obpterm.deck.open()");
  await until("document.activeElement === document.querySelector('#deck .dgrid')", "the deck holding focus");
  await until("document.querySelector('.dcard[data-state=blocked]') !== null", "the blocked card");
  assert.ok(await evaluate("document.querySelector('.dcard').classList.contains('selected')"), "the loudest card is selected");
  // Working chip carries elapsed time once workingSince is old enough.
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${busyPane}); p.agent.workingSince = Date.now() - 300000; })()`);
  await evaluate("document.querySelector('#deck .dgrid').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }))");
  const a14 = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 1400 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 1400) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(a14.at(-1), { pending: "p-140", allow: true }, "keyboard Allow reached the host");
  await evaluate("window.obpterm.deck.close()");

  // The rail draws OSC 9;4 progress.
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${busyPane}); p.progress = 42; window.obpterm.paint(); })()`);
  await until("!!document.querySelector('.tab.has-prog')", "a progress sliver on the rail row");
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${busyPane}); p.progress = null; window.obpterm.paint(); })()`);

  // Duplicate tab lands in the same directory and never carries a session id along.
  await evaluate("void (window.__dupPane = window.obpterm.tab.active)"); // the fixture must be undone on THIS pane
  await evaluate("window.obpterm.tab.active.cwd = '/tmp/dup-test'");
  await evaluate("window.obpterm.tab.active.profile.args = ['--session-id', 'sess-old']");
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'D', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "the duplicated tab");
  assert.equal(await evaluate("window.obpterm.tab.active.cwd"), "/tmp/dup-test", "the duplicate keeps the directory");
  assert.ok(!(await evaluate("window.obpterm.tab.active.profile.args.includes('sess-old')")), "the duplicate minted its own session");
  await evaluate("window.obpterm.closeTab(window.obpterm.tab)");
  await evaluate("window.__dupPane.cwd = null; window.__dupPane.profile.args = []"); // undo the fixture on the right pane

  // Find reports which match of how many.
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate("window.obpterm.tab.active.term.term.write('needle one needle two needle three\\r\\n')");
  await new Promise((r) => setTimeout(r, 200));
  await evaluate("window.obpterm.find.open()");
  await evaluate("(() => { const i = document.querySelector('#find input'); i.value = 'needle'; i.dispatchEvent(new Event('input')); })()");
  await until("/^\\d+\\/\\d+$/.test(document.querySelector('#find .count').textContent)", "the match count");
  await evaluate("document.querySelector('#find .close').click()");

  // The phone push is suppressed while the window has focus — no accidental spam.
  await evaluate("(() => { window.__ntfy = 0; window.obpterm.tp.ntfy = async () => { window.__ntfy++; }; window.obpterm.config.ntfy_url = 'https://example.invalid/t'; })()");
  await evaluate("window.obpterm.agentAlert('Test', 'needs you')");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate("window.__ntfy"), 0, "focused window means no phone push");
  await evaluate("window.obpterm.config.ntfy_url = null");

  // cleanup: end the extra tab
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
}


// ---- v0.15.0: danger tier, deck reply, always-allow, diffstat/ctx, review split -----------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  const answers = (reqId) => new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === reqId) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a tab for wave 1");
  const wavePane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");

  // A dangerous request: red card, 'a' refuses, 'y' allows.
  await injectDev({ pane: wavePane, state: "blocked", session_id: "sess-15", detail: "Running rm -rf build", pending_id: "p-150", options: [], tool: "Bash", tool_input: "rm -rf build" });
  await until(`window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${wavePane})?.agent.state === 'blocked'`, "the dangerous block");
  await evaluate("window.obpterm.deck.open()");
  await until("!!document.querySelector('.dcard.danger')", "the red card");
  const before = (await answers(1500)).length;
  await evaluate("document.querySelector('#deck .dgrid').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await answers(1501)).length, before, "muscle-memory a did not approve the red card");
  await evaluate("document.querySelector('#deck .dgrid').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', key: 'y', bubbles: true, cancelable: true }))");
  await until("document.querySelector('.dcard.danger') === null", "the card quieting after y");
  const a15 = await answers(1502);
  assert.deepEqual(a15.at(-1), { pending: "p-150", allow: true }, "y allowed it deliberately");

  // Always-allow on a benign command: the rule lands and the verdict travels.
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${wavePane}); p.cwd = '/tmp/wave1'; })()`);
  await injectDev({ pane: wavePane, state: "blocked", session_id: "sess-15", detail: "Running npm test", pending_id: "p-151", options: [], tool: "Bash", tool_input: "npm test" });
  await until("!!document.querySelector('.dcard[data-state=blocked]')", "the benign block");
  await evaluate("(() => { window.__rules = []; window.obpterm.tp.allowRule = async (cwd, rule) => { window.__rules.push([cwd, rule]); }; })()");
  await evaluate("document.querySelector('#deck .dgrid').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }))");
  await until("window.__rules.length === 1", "the rule saved");
  assert.deepEqual(await evaluate("window.__rules[0]"), ["/tmp/wave1", "Bash(npm:*)"], "the rule pins the command word");
  const a151 = await answers(1503);
  assert.deepEqual(a151.at(-1), { pending: "p-151", allow: true }, "always also allowed the held request");

  // Reply without attaching: t focuses the input, Enter writes into the pty.
  await injectDev({ pane: wavePane, state: "waiting", session_id: "sess-15", detail: "Which option?", pending_id: null, options: ["A", "B"] });
  await until("!!document.querySelector('.dcard[data-state=waiting] .dreply:not([hidden])')", "the reply input shown");
  await evaluate("(() => { window.__writes = []; const real = window.obpterm.tp.write; window.__realWrite = real; window.obpterm.tp.write = async (id, d) => { window.__writes.push([id, d]); }; })()");
  await evaluate("document.querySelector('#deck .dgrid').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true, cancelable: true }))");
  await until("document.activeElement?.matches('.dreply input')", "the input focused by t");
  await evaluate("(() => { const i = document.querySelector('.dcard[data-state=waiting] .dreply input') ?? document.activeElement; i.value = 'use option B'; i.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); })()");
  await until("window.__writes.length === 1", "the reply written");
  assert.deepEqual(await evaluate("window.__writes[0]"), [wavePane, "use option B\r"], "the reply hit the right pty with Enter");
  await evaluate("void (window.obpterm.tp.write = window.__realWrite)");
  assert.equal(await evaluate("window.obpterm.tp.write === window.__realWrite"), true, "the real write is back");

  // Diffstat + context land on the card through the slow lane.
  await evaluate("(() => { window.obpterm.tp.gitShortstat = async () => '2 files changed, 4 insertions(+), 1 deletion(-)'; window.obpterm.tp.sessionContext = async () => 85; })()");
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${wavePane}); p.claudeSessionId = 'sess-15'; })()`);
  await evaluate("window.obpterm.deck.close(); window.obpterm.deck.open()");
  await until("[...document.querySelectorAll('.dcard .dfoot')].some(f => f.textContent.includes('+4 \\u22121') || f.textContent.includes('+4 −1'))", "the diffstat chip");
  await until("[...document.querySelectorAll('.dcard .dctx .v')].some(v => v.textContent === '85%')", "the context bar");
  await evaluate("window.obpterm.deck.close()");

  // Review split: a second pane opens where you are and asks git for the diff.
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate("window.obpterm.tab.active.cwd = null"); // an earlier fixture may have poisoned it
  const panesBefore = await evaluate("window.obpterm.paneCount(window.obpterm.tab)");
  await evaluate("void window.obpterm.reviewSplit()");
  await until(`window.obpterm.paneCount(window.obpterm.tab) === ${panesBefore + 1}`, "the review split");
  await until(`(() => { const b = window.obpterm.tab.active.term.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i)?.translateToString(true) ?? ''; return t.includes('git diff'); })()`, "the diff asked for");
  await evaluate("window.obpterm.closePane(window.obpterm.tab.active)");

  // cleanup
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
}


// ---- v0.16.0: slots, worktree spawn + janitor, context visualizer ------------------------
{
  // Slots: every tab holds a distinct small integer and its shells carry it as env.
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second tab for slots");
  const slots = await evaluate("window.obpterm.tabs.map(t => t.slot)");
  assert.equal(new Set(slots).size, slots.length, "slots are unique");
  assert.ok(slots.every((n) => n >= 1), "slots start at 1");
  assert.equal(
    await evaluate("window.obpterm.tabs[1].active.profile.env.OBPTERM_SLOT"),
    String(slots[1]),
    "the shell environment carries the slot",
  );

  // Worktree spawn: the flow prompts, creates, and opens the tab in the new path.
  await evaluate("(() => { window.__wt = []; window.obpterm.tp.worktreeAdd = async (cwd, name) => { window.__wt.push([cwd, name]); return '/tmp/repo-' + name; }; })()");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate("window.obpterm.tab.active.cwd = '/tmp/repo'");
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', key: 'U', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
  await until("!document.querySelector('#rail-new').hidden", "the worktree name prompt");
  await evaluate("(() => { const i = document.querySelector('#rail-new input'); i.value = 'feat-x'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); })()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "the worktree tab");
  assert.deepEqual(await evaluate("window.__wt[0]"), ["/tmp/repo", "feat-x"], "worktree add got the repo and the name");
  assert.equal(await evaluate("window.obpterm.tab.active.cwd"), "/tmp/repo-feat-x", "the tab opened inside the worktree");
  assert.equal(await evaluate("window.obpterm.title(window.obpterm.tab)"), "feat-x", "the tab is named after the branch");

  // Janitor: closing a tab in a merged clean worktree offers the sweep, and the sweep runs.
  await evaluate("(() => { window.__rm = []; window.obpterm.tp.worktreeStatus = async () => ({ main_root: '/tmp/repo', path: '/tmp/repo-feat-x', branch: 'feat-x', clean: true, merged: true }); window.obpterm.tp.worktreeRemove = async (...a) => { window.__rm.push(a); }; })()");
  await evaluate("window.obpterm.closeTab(window.obpterm.tab)");
  await until("document.querySelector('#toast .undo')?.textContent === 'Remove it'", "the janitor's offer");
  await evaluate("document.querySelector('#toast .undo').click()");
  await until("window.__rm.length === 1", "the sweep ran");
  assert.deepEqual(await evaluate("window.__rm[0]"), ["/tmp/repo", "/tmp/repo-feat-x", "feat-x"], "sweep removes the path and the branch");

  // Context visualizer: the deck bar and the status chip both read the percentage.
  await evaluate("(() => { window.obpterm.tp.sessionContext = async () => 91; })()");
  await evaluate("(() => { const p = window.obpterm.tab.active; p.claudeSessionId = 'sess-ctx'; p.ctxPct = 91; window.obpterm.deck.open(); })()");
  await until("!!document.querySelector('.dcard .dctx:not([hidden])')", "the deck context bar");
  assert.ok(await evaluate("document.querySelector('.dcard .dctx').classList.contains('full')"), "91% shows red");
  assert.equal(await evaluate("document.querySelector('.dcard .dctx .v').textContent"), "91%");
  await evaluate("window.obpterm.deck.close()");
  await evaluate("window.obpterm.status.paintCtx()");
  await until("!document.querySelector('#ctx-chip').hidden", "the status-bar context gauge");
  assert.equal(await evaluate("document.querySelector('#ctx-chip .v').textContent"), "ctx 91%");
  await evaluate("(() => { const p = window.obpterm.tab.active; p.ctxPct = null; p.claudeSessionId = null; p.cwd = null; window.obpterm.status.paintCtx(); })()");

  // cleanup: drop the extra tab
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
}


// ---- v0.16.1: the update chip idles on the version and self-checks quietly ----------------
await until("/^v\\d+\\.\\d+\\.\\d+/.test(document.querySelector('#update-chip').textContent)", "the version on the chip");
await evaluate("(() => { window.obpterm.tp.updateCheck = async () => ({ newer: false, version: '0.0.0', name: 'x', url: '' }); window.obpterm.config.update_repo = 'x/y'; })()");
await evaluate("void window.obpterm.status.checkUpdates(true)");
await new Promise((r) => setTimeout(r, 300));
assert.match(await evaluate("document.querySelector('#update-chip').textContent"), /^v\d+\.\d+\.\d+/, "a quiet no-update check keeps the version");
await evaluate("(() => { window.obpterm.tp.updateCheck = async () => ({ newer: true, version: '99.0.0', name: 'obpterm 99', url: '' }); })()");
await evaluate("void window.obpterm.status.checkUpdates(true)");
await until("document.querySelector('#update-chip').textContent === 'Update to 99.0.0'", "a found update changes the chip");
await evaluate("(() => { window.obpterm.status.pendingUpdate = null; document.querySelector('#update-chip').classList.remove('has-update'); window.obpterm.config.update_repo = null; })()");

// ---- settings backup: the new rows exist and import round-trips through the UI handler ----
await evaluate("window.obpterm.settings.open('files')");
await until("[...document.querySelectorAll('#settings .sw-row b')].some(b => b.textContent === 'Mirror settings to a folder')", "the mirror row");
assert.ok(await evaluate("[...document.querySelectorAll('#settings .sw-btn')].some(b => b.textContent === 'Save settings to file')"), "the export button");
// Import path: feed the hidden file input's handler a crafted settings file.
const importedFont = "Cascadia Code Import Test";
await evaluate(`(() => {
  const input = document.querySelector('#settings input[type=file]');
  const cfg = JSON.parse(JSON.stringify(window.obpterm.config));
  cfg.font_family = ${JSON.stringify(importedFont)};
  cfg.session = { junk: true };
  const file = new File([JSON.stringify(cfg)], 'obpterm-config.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.onchange();
})()`);
await until(`window.obpterm.config.font_family === ${JSON.stringify(importedFont)}`, "the imported font applied");
assert.equal(await evaluate("window.obpterm.config.session?.junk ?? null"), null, "machine-bound session never imports");
// Garbage is refused with the config untouched.
await evaluate(`(() => {
  const input = document.querySelector('#settings input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File(['{"nope": 1}'], 'x.json', { type: 'application/json' }));
  input.files = dt.files;
  input.onchange();
})()`);
await new Promise((r) => setTimeout(r, 300));
assert.equal(await evaluate("window.obpterm.config.font_family"), importedFont, "a bad file changes nothing");
await evaluate("window.obpterm.config.font_family = 'JetBrains Mono'"); // put the font back
await evaluate("window.obpterm.settings.close()");

// ---- shortcut rebinding: the map follows config, and the old chord is released ------------
await evaluate("window.obpterm.settings.open('keyboard')");
await until("document.querySelectorAll('#settings .sw-chord').length > 10", "the rebindable rows");
// Rebind the palette to Ctrl+Shift+O through the capture flow.
await evaluate("[...document.querySelectorAll('#settings .sw-key')].find(k => k.querySelector('b').textContent === 'Command palette').querySelector('.sw-chord').click()");
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
await until("window.obpterm.config.keybindings['palette'] === 'Ctrl+Shift+KeyO'", "the override stored");
await evaluate("window.obpterm.settings.close()");
// The new chord opens it…
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
await until("window.obpterm.palette.isOpen", "the palette on the new chord");
await evaluate("window.obpterm.palette.close()");
// …and the old one no longer does.
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))");
await new Promise((r) => setTimeout(r, 200));
assert.equal(await evaluate("window.obpterm.palette.isOpen"), false, "the default chord was released");
// A conflicting rebind is refused.
await evaluate("window.obpterm.settings.open('keyboard')");
await until("document.querySelectorAll('#settings .sw-chord').length > 10", "the rows again");
await evaluate("[...document.querySelectorAll('#settings .sw-key')].find(k => k.querySelector('b').textContent === 'New tab').querySelector('.sw-chord').click()");
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
await new Promise((r) => setTimeout(r, 200));
assert.equal(await evaluate("window.obpterm.config.keybindings['new-tab'] ?? null"), null, "the taken chord was refused");
// Reset all puts Ctrl+K back.
await evaluate("[...document.querySelectorAll('#settings .sw-btn')].find(b => b.textContent === 'Reset all to defaults').click()");
await until("Object.keys(window.obpterm.config.keybindings).length === 0", "the overrides cleared");
await evaluate("window.obpterm.settings.close()");
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))");
await until("window.obpterm.palette.isOpen", "Ctrl+K back after the reset");
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

// The login switcher: lists the saved profiles, marks the live one, and a switch moves it.
await evaluate("[...document.querySelectorAll('#settings .sw-nav button')].find(b => b.textContent.startsWith('Claude logins')).click()");
await until("document.querySelectorAll('#settings .sw-item').length === 2", "two saved logins");
assert.equal(await evaluate("document.querySelector('#settings .sw-item.on b').textContent"), "personal");
await evaluate("[...document.querySelectorAll('#settings .sw-btn')].find(b => b.textContent === 'Switch to').click()");
await until("document.querySelector('#settings .sw-item.on b')?.textContent === 'is'", "the switch landing");
assert.match(await evaluate("document.querySelector('#toast').textContent"), /Switched to is/);
await evaluate("[...document.querySelectorAll('#settings .sw-btn')].find(b => b.textContent === 'Switch to').click()");
await until("document.querySelector('#settings .sw-item.on b')?.textContent === 'personal'", "and back");

// Every section renders; a section that throws would leave the body empty.
for (const title of ["Terminal", "Appearance", "Rail", "Startup", "Profiles", "Accounts", "Claude logins", "Projects", "Keyboard", "Updates", "Files"]) {
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

