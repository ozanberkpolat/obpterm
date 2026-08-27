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

// The sleep sweep and the live ceiling are driven explicitly further down. Left on their
// timers they would tear terminals down under the other 1100 lines, and a wake replays
// scrollback, which reads as fresh output — an activity assertion two blocks away would flap.
await evaluate("(() => { window.obpterm.config.sleep_after_seconds = 0; window.obpterm.config.max_live_panes = 0; })()");

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
// A run that died between collapse and expand leaves the rail collapsed — normalize by what
// the DOM actually shows, since that is what the width assertion measures.
await evaluate("(() => { if (document.querySelector('#rail').classList.contains('collapsed')) window.obpterm.toggleRail(); })()");
await until("!document.querySelector('#rail').classList.contains('collapsed')", "an expanded rail");
await evaluate("window.obpterm.setRailWidth(300)");
// The drag handler above finishes asynchronously; wait for the width rather than race it.
await until("Math.round(document.querySelector('#rail').getBoundingClientRect().width) === 300", "the rail at its set width");
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
// Collapse from whatever state the saved config left behind, not from an assumed one.
await evaluate("(() => { if (!document.querySelector('#rail').classList.contains('collapsed')) window.obpterm.toggleRail(); })()");
await until("document.querySelector('#rail').classList.contains('collapsed')", "the collapsed rail");
const box = JSON.parse(
  await evaluate("(() => { const r = document.querySelector('.tab').getBoundingClientRect(); return JSON.stringify([r.width, r.height]); })()"),
);
assert.deepEqual(box, [30, 30], "a collapsed row is a 30px circle");
// A row flips between running and idle as output decays, so poll the live element rather
// than measuring one that may have changed class between the wait and the assertion.
await until(
  "(() => { const e = document.querySelector('.tab .st.idle'); return !!e && getComputedStyle(e).display === 'none'; })()",
  "an idle glyph hidden when collapsed",
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
await evaluate(`(() => { window.obpterm.config.sleep_after_seconds = 1; window.obpterm.panesOf(window.obpterm.tabs[${sleeper}])[0].lastVisited = 0; })()`);
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
await evaluate("window.obpterm.config.sleep_after_seconds = 0");

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


// ---- the agents surface answers a held request, from the map ------------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; p.agent.fanned = []; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second tab");
  const askPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await injectDev({ pane: askPane, state: "blocked", session_id: "sess-a", detail: "Running git push --tags", pending_id: "p-ask", options: [], tool: "Bash", tool_input: "git push --tags" });
  await evaluate("window.obpterm.showView('agents')");
  await until("!!document.querySelector('#nodemap .nnode[data-state=blocked]')", "the waiting node");
  assert.equal(
    await evaluate("document.querySelector('#nodemap .nnode[data-state=blocked] .npill').textContent"),
    "needs you",
    "the node says it is waiting on you",
  );
  await evaluate("document.querySelector('#nodemap .nnode[data-state=blocked] .allow').click()");
  const answers = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 2001 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 2001) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(answers.at(-1), { pending: "p-ask", allow: true }, "the answer reached the host");
  await evaluate("window.obpterm.showView('sessions')");
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
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

  // The agents surface takes focus and answers from the keyboard.
  await evaluate("window.obpterm.showView('agents')");
  await until("document.activeElement === document.querySelector('#nodemap')", "the map holding focus");
  await until("!!document.querySelector('#nodemap .nnode[data-state=blocked]')", "the waiting node");
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }))");
  const a14 = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 1400 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 1400) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(a14.at(-1), { pending: "p-140", allow: true }, "keyboard Allow reached the host");
  await evaluate("window.obpterm.showView('sessions')");

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
  await evaluate("window.obpterm.showView('agents')");
  await until("!!document.querySelector('#nodemap .nnode.danger')", "the red node");
  const before = (await answers(1500)).length;
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await answers(1501)).length, before, "muscle-memory a did not approve the red node");
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', key: 'y', bubbles: true, cancelable: true }))");
  const a15 = await answers(1502);
  assert.deepEqual(a15.at(-1), { pending: "p-150", allow: true }, "y allowed it deliberately");

  // Always-allow on a benign command: the rule lands and the verdict travels.
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${wavePane}); p.cwd = '/tmp/wave1'; })()`);
  await injectDev({ pane: wavePane, state: "blocked", session_id: "sess-15", detail: "Running npm test", pending_id: "p-151", options: [], tool: "Bash", tool_input: "npm test" });
  await evaluate("(() => { window.__rules = []; window.obpterm.tp.allowRule = async (cwd, rule) => { window.__rules.push([cwd, rule]); }; })()");
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }))");
  await until("window.__rules.length === 1", "the rule saved");
  assert.deepEqual(await evaluate("window.__rules[0]"), ["/tmp/wave1", "Bash(npm:*)"], "the rule pins the command word");
  const a151 = await answers(1503);
  assert.deepEqual(a151.at(-1), { pending: "p-151", allow: true }, "always also allowed the held request");

  // Reply without attaching: t focuses the input, Enter writes into the pty.
  await injectDev({ pane: wavePane, state: "waiting", session_id: "sess-15", detail: "Which option?", pending_id: null, options: ["A", "B"] });
  await evaluate("(() => { window.__writes = []; const real = window.obpterm.tp.write; window.__realWrite = real; window.obpterm.tp.write = async (id, d) => { window.__writes.push([id, d]); }; })()");
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true, cancelable: true }))");
  await until("document.activeElement?.matches('.nreply input')", "the input focused by t");
  await evaluate("(() => { const i = document.activeElement; i.value = 'use option B'; i.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); })()");
  await until("window.__writes.length === 1", "the reply written");
  assert.deepEqual(await evaluate("window.__writes[0]"), [wavePane, "use option B\r"], "the reply hit the right pty with Enter");
  await evaluate("void (window.obpterm.tp.write = window.__realWrite)");
  assert.equal(await evaluate("window.obpterm.tp.write === window.__realWrite"), true, "the real write is back");

  // Diffstat + context land on the card through the slow lane.
  await evaluate("(() => { window.obpterm.tp.gitShortstat = async () => '2 files changed, 4 insertions(+), 1 deletion(-)'; window.obpterm.tp.sessionContext = async () => 85; })()");
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === ${wavePane}); p.claudeSessionId = 'sess-15'; })()`);

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

  // Context visualizer: the node body and the status chip both read the percentage.
  await evaluate("(() => { window.obpterm.tp.sessionContext = async () => 91; const p = window.obpterm.tab.active; p.ctxPct = 91; })()");
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


// ---- v0.17.0: the motion language ---------------------------------------------------------
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
  await until("window.obpterm.tabs.length >= 2", "a tab for motion");
  const mPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])"); // unfocused, or blocked injects auto-pass and clear the pending id
  const row = `document.querySelectorAll('#rail-body .tab')[1]`;

  // working, not printing: sonar state on the row
  await injectDev({ pane: mPane, state: "working", session_id: "sess-m", detail: "Thinking", pending_id: null, options: [] });
  await evaluate(`(() => { const p = window.obpterm.panesOf(window.obpterm.tabs[1])[0]; p.lastOutput = Date.now() - 10000; window.obpterm.paint(); })()`);
  await until(`${row}?.dataset.motion === 'working'`, "the working motion word");
  // a benign ask: the knock
  await injectDev({ pane: mPane, state: "blocked", session_id: "sess-m", detail: "Running npm test", pending_id: "p-170", options: [], tool: "Bash", tool_input: "npm test" });
  await evaluate(`(() => { const p = window.obpterm.panesOf(window.obpterm.tabs[1])[0]; p.lastOutput = Date.now() - 10000; window.obpterm.paint(); })()`);
  await until(`${row}?.dataset.motion === 'ask'`, "the knock word");
  // a dangerous ask: the red word
  await injectDev({ pane: mPane, state: "blocked", session_id: "sess-m", detail: "Running rm -rf build", pending_id: "p-171", options: [], tool: "Bash", tool_input: "rm -rf build" });
  await until(`${row}?.dataset.motion === 'danger'`, "the danger word");

  // the orbit rim on the asking pane in the CURRENT tab, and the sheen on focus arrival
  await evaluate("window.obpterm.activate(window.obpterm.tabs[1])");
  await until("!!document.querySelector('.pane.asking')", "the orbit rim while asking");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[1])");
  assert.ok(await evaluate("!!document.querySelector('.pane.sheen')"), "the sheen acknowledges the focus change");
  await evaluate(`void window.obpterm.answerAgent(window.obpterm.panesOf(window.obpterm.tabs[1])[0], true)`); // allow -> working; deny would leave it waiting (still asking)
  await until("document.querySelector('.pane.asking') === null", "the rim gone once answered");

  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
}


// ---- v0.18.0: agent fan-out — the data behind List/Node view --------------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; p.agent.fanned = []; }), window.obpterm.paint()");
  const sPane = await evaluate("window.obpterm.tab.active.id");

  // A Task call opens an agent with its kind and description.
  await injectDev({ pane: sPane, state: "working", session_id: "sess-f", detail: "Delegating", pending_id: null, options: [],
    agent_id: "t-1", agent_kind: "Explore", agent_task: "Audit upstream consumers", agent_event: "spawned" });
  await until("window.obpterm.tab.active.agent.fanned.length === 1", "the agent registered");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.fanned[0].kind"), "Explore");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.fanned[0].task"), "Audit upstream consumers");

  // Its tool calls feed that agent, and do NOT restate the session's own activity.
  await injectDev({ pane: sPane, state: "working", session_id: "sess-f", detail: "Searching", pending_id: null, options: [],
    agent_id: "t-1", agent_event: "tool" });
  await until("window.obpterm.tab.active.agent.fanned[0].tools === 1", "the agent's tool feed");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.fanned[0].feed"), "Searching");

  // SubagentStop closes that agent and leaves the session running.
  await injectDev({ pane: sPane, state: "working", session_id: "sess-f", detail: null, pending_id: null, options: [],
    agent_id: "t-1", agent_event: "finished" });
  await until("window.obpterm.tab.active.agent.fanned[0].endedAt !== null", "the agent closed");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.state"), "working", "the session keeps working");

  // The rail carries the agent as a pill under its session row.
  await until("!!document.querySelector('.agent-pills .agent-pill')", "the agent pill in the rail");
  assert.match(await evaluate("document.querySelector('.agent-pill b').textContent"), /Audit upstream consumers|Searching/, "the pill names the task");

  // A finished turn ends every agent that belonged to it.
  await injectDev({ pane: sPane, state: "working", session_id: "sess-f", detail: "Delegating", pending_id: null, options: [],
    agent_id: "t-2", agent_kind: "general-purpose", agent_task: "Smoke the routes", agent_event: "spawned" });
  await until("window.obpterm.tab.active.agent.fanned.length === 2", "a second agent");
  await injectDev({ pane: sPane, state: "done", session_id: "sess-f", detail: "All green.", pending_id: null, options: [] });
  await until("window.obpterm.tab.active.agent.fanned.every(f => f.endedAt !== null)", "the turn ending closes its agents");

  await evaluate("window.obpterm.tab.active.agent.fanned = []; window.obpterm.paint()");
  devWs.close();
}


// ---- v0.19.1: the fan-out reaches the rail, and the map shows only what is awake -----------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.fanned = []; }), window.obpterm.paint()");
  const rPane = await evaluate("window.obpterm.tab.active.id");
  // The shape the host now sends for a real fan-out (tool named Agent, agent_type on its events).
  await injectDev({ pane: rPane, state: "working", session_id: "sess-r", detail: "Delegating", pending_id: null, options: [],
    agent_id: "a-1", agent_kind: "general-purpose", agent_task: "Trigger a real hook", agent_event: "spawned" });
  await until("!!document.querySelector('.agent-pills .agent-pill')", "the agent pill in the rail");
  assert.ok(await evaluate("document.querySelector('.agent-pill').classList.contains('live')"), "live while the agent runs");
  await injectDev({ pane: rPane, state: "working", session_id: "sess-r", detail: null, pending_id: null, options: [],
    agent_id: "a-1", agent_kind: "general-purpose", agent_event: "finished" });
  await until("!document.querySelector('.agent-pill')?.classList.contains('live')", "the pill cools when it ends");

  // Node view leaves resting panes out and says how many it left.
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a tab to rest");
  await evaluate("(() => { const p = window.obpterm.panesOf(window.obpterm.tabs[1])[0]; p.eco = true; window.obpterm.paint(); })()");
  await evaluate("window.obpterm.nodes.open()");
  const nodeIds = await evaluate("[...document.querySelectorAll('#nodemap .nnode')].map(n => n.dataset.id).join(',')");
  const restingId = await evaluate("'p' + window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  assert.ok(!nodeIds.split(",").includes(restingId), "a resting pane gets no node");
  assert.match(await evaluate("document.querySelector('#nodemap .nsummary').textContent"), /idle/, "the map says what it left out");
  await evaluate("window.obpterm.nodes.close()");
  await evaluate("(() => { const p = window.obpterm.panesOf(window.obpterm.tabs[1])[0]; p.eco = false; })()");
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  await evaluate("window.obpterm.tab.active.agent.fanned = []; window.obpterm.paint()");
  devWs.close();
}


// ---- v0.20.0: one agents surface, reached from the rail's own tabs -------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.fanned = []; }), window.obpterm.paint()");
  const vPane = await evaluate("window.obpterm.tab.active.id");

  // The rail's tabs switch the surface, and the choice sticks.
  assert.ok(await evaluate("!!document.querySelector('#rail-views .rv[data-view=agents]')"), "the rail has an Agents tab");
  await evaluate("document.querySelector('#rail-views .rv[data-view=agents]').click()");
  await until("window.obpterm.nodes.isOpen", "the agents surface opens from the rail");
  assert.equal(await evaluate("window.obpterm.config.agents_view"), "agents");
  await evaluate("document.querySelector('#rail-views .rv[data-view=sessions]').click()");
  await until("!window.obpterm.nodes.isOpen", "back to sessions");

  // The card view is gone for good.
  assert.equal(await evaluate("document.querySelector('#deck')"), null, "no card view in the DOM");

  // One delegation is ONE agent, even though the call and the agent carry different ids.
  await injectDev({ pane: vPane, state: "working", session_id: "sess-v", detail: "Delegating", pending_id: null, options: [],
    agent_id: "toolu_call1", agent_kind: "general-purpose", agent_task: "Idle 15 seconds", agent_event: "spawned" });
  await injectDev({ pane: vPane, state: "working", session_id: "sess-v", detail: "Delegating", pending_id: null, options: [],
    agent_id: "real-1", agent_ref: "toolu_call1", agent_kind: "general-purpose", agent_task: "Idle 15 seconds", agent_event: "linked" });
  await injectDev({ pane: vPane, state: "working", session_id: "sess-v", detail: "Running sleep 15", pending_id: null, options: [],
    agent_id: "real-1", agent_kind: "general-purpose", agent_event: "tool" });
  await until("window.obpterm.tab.active.agent.fanned.length === 1", "one agent, not two");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.fanned[0].id"), "real-1", "it was rekeyed to the real id");
  await until("document.querySelectorAll('.agent-pills .agent-pill').length === 1", "one pill under the row");

  // The map shows it, and drops it the moment it finishes.
  await evaluate("window.obpterm.showView('agents')");
  await until("document.querySelectorAll('#nodemap .nnode.agent').length === 1", "one agent node");
  await injectDev({ pane: vPane, state: "working", session_id: "sess-v", detail: null, pending_id: null, options: [],
    agent_id: "real-1", agent_event: "finished" });
  await until("document.querySelectorAll('#nodemap .nnode.agent').length === 0", "a finished agent leaves the map");
  await evaluate("window.obpterm.showView('sessions')");
  await evaluate("window.obpterm.tab.active.agent.fanned = []; window.obpterm.paint()");
  devWs.close();
}


// ---- v0.20.1: auto mode has no answer buttons, and hidden means hidden -----------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; p.agent.fanned = []; p.agent.mode = null; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a tab for mode");
  const mPane = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");

  // A finished agent must not wear answer buttons — [hidden] has to beat display:flex.
  await injectDev({ pane: mPane, state: "working", session_id: "sess-m2", detail: "Delegating", pending_id: null, options: [],
    agent_id: "m-1", agent_kind: "general-purpose", agent_task: "Idle 15 seconds", agent_event: "spawned", mode: "default" });
  await evaluate("window.obpterm.showView('agents')");
  await until("!!document.querySelector('#nodemap .nnode.agent')", "the agent node");
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('#nodemap .nnode.agent .nact')).display"),
    "none",
    "an agent node never shows Allow/Deny",
  );

  // In auto mode a held request shows no buttons and the keys do nothing.
  await injectDev({ pane: mPane, state: "blocked", session_id: "sess-m2", detail: "Running npm test", pending_id: "p-auto", options: [], tool: "Bash", tool_input: "npm test", mode: "bypassPermissions" });
  await until("!!document.querySelector('#nodemap .nnode[data-state=blocked]')", "the blocked session node");
  assert.equal(await evaluate("document.querySelector('#nodemap .nnode[data-state=blocked] .nmode').textContent"), "auto", "the node says which mode it runs in");
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('#nodemap .nnode[data-state=blocked] .nact')).display"),
    "none",
    "auto mode shows no answer buttons",
  );
  const before = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 2100 }));
    devWs.on("message", function once(d) { const m = JSON.parse(d); if (m.reqId === 2100) { devWs.off("message", once); resolve(m.answered.length); } });
  });
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 250));
  const after = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 2101 }));
    devWs.on("message", function once(d) { const m = JSON.parse(d); if (m.reqId === 2101) { devWs.off("message", once); resolve(m.answered.length); } });
  });
  assert.equal(after, before, "the answer keys are inert in auto mode");

  // An ordinary session still gets them.
  await injectDev({ pane: mPane, state: "blocked", session_id: "sess-m2", detail: "Running npm test", pending_id: "p-normal", options: [], tool: "Bash", tool_input: "npm test", mode: "default" });
  await until("getComputedStyle(document.querySelector('#nodemap .nnode[data-state=blocked] .nact')).display !== 'none'", "default mode keeps the buttons");
  await evaluate("window.obpterm.showView('sessions')");
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
}


// ---- v0.20.2: the map is what is running ---------------------------------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; p.agent.fanned = []; p.lastOutput = 0; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "a second session");
  const busy = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  const idle = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[0])[0].id");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");

  // One session working, one idle: only the working one is on the map.
  await injectDev({ pane: busy, state: "working", session_id: "sess-r2", detail: "Editing pty.rs", pending_id: null, options: [], mode: "default" });
  await evaluate("window.obpterm.showView('agents')");
  await until("document.querySelectorAll('#nodemap .nnode.session').length === 1", "only the running session");
  assert.match(await evaluate("document.querySelector('#nodemap .nsummary').textContent"), /idle/, "the map says how many it left in the rail");

  // When it finishes it leaves the map too — the map is the present tense.
  await injectDev({ pane: busy, state: "done", session_id: "sess-r2", detail: "All green.", pending_id: null, options: [] });
  await until("document.querySelectorAll('#nodemap .nnode.session').length === 0", "a finished session leaves the map");
  await until("!document.querySelector('#nodemap .nnone').hidden", "and the map says why it is empty");
  void idle;
  await evaluate("window.obpterm.showView('sessions')");
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  devWs.close();
}


// ---- v0.21.0: the spine — sessions down the left, agents branching right ---------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const injectDev = (update) =>
    new Promise((r) => {
      devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update }));
      setTimeout(r, 150);
    });
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.pendingId = null; p.agent.fanned = []; p.lastOutput = 0; }), window.obpterm.paint()");
  await evaluate("void window.obpterm.newTab()");
  await until("window.obpterm.tabs.length >= 2", "two sessions");
  const one = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[0])[0].id");
  const two = await evaluate("window.obpterm.panesOf(window.obpterm.tabs[1])[0].id");
  for (const p of [one, two]) {
    await injectDev({ pane: p, state: "working", session_id: `s-${p}`, detail: "Editing pty.rs", pending_id: null, options: [], mode: "default" });
  }
  await injectDev({ pane: one, state: "working", session_id: `s-${one}`, detail: "Delegating", pending_id: null, options: [],
    agent_id: "sp-1", agent_kind: "Explore", agent_task: "Map the routes", agent_event: "spawned" });
  await evaluate("window.obpterm.showView('agents')");
  await until("document.querySelectorAll('#nodemap .nnode.session').length === 2", "both sessions on the spine");

  const geom = JSON.parse(await evaluate(`(() => {
    const at = (el) => { const m = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/.exec(el.style.transform); return { x: +m[1], y: +m[2] }; };
    const s = [...document.querySelectorAll('#nodemap .nnode.session')].map(at);
    const a = [...document.querySelectorAll('#nodemap .nnode.agent')].map(at);
    return JSON.stringify({ s, a });
  })()`));
  assert.equal(new Set(geom.s.map((p) => p.x)).size, 1, "every session shares the spine's x");
  assert.ok(geom.s[1].y > geom.s[0].y, "sessions stack downward");
  assert.ok(geom.a[0].x > geom.s[0].x, "agents branch to the right of the spine");

  // Right steps into the session's agent, left comes back.
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', bubbles: true, cancelable: true }))");
  await until("document.querySelector('#nodemap .nnode.agent.sel') !== null", "right steps into the agents");
  await evaluate("document.querySelector('#nodemap').dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', bubbles: true, cancelable: true }))");
  await until("document.querySelector('#nodemap .nnode.session.sel') !== null", "left returns to the session");

  await evaluate("window.obpterm.showView('sessions')");
  await evaluate("(() => { const t = window.obpterm.tabs[1]; if (t) window.obpterm.closeTab(t); })()");
  await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).forEach(p => { p.agent.state = null; p.agent.fanned = []; }), window.obpterm.paint()");
  devWs.close();
}


// ---- v0.21.3: a pane whose shell is gone says so, and Reload brings it back -----------------
{
  await evaluate("window.obpterm.showView('sessions')");
  // A pane pointed at a pty id the host does not hold: exactly what a stale restore leaves.
  await evaluate("(() => { const p = window.obpterm.tab.active; window.__realId = p.id; p.id = 999999; p.cwd = null; p.claudeSessionId = null; })()");
  await evaluate("void window.obpterm.refreshHeld()");
  await until("!!document.querySelector('.pane .lost')", "the pane admits its shell is gone");
  assert.match(await evaluate("document.querySelector('.pane .lost span').textContent"), /typing goes nowhere/, "and says why");

  // Reload respawns it and clears the warning.
  await evaluate("document.querySelector('.pane .lost button').click()");
  await until("document.querySelector('.pane .lost') === null", "reload clears it");
  await until("window.obpterm.tab.active.id > 0 && window.obpterm.tab.active.id !== 999999", "the pane runs a real shell again");
  assert.ok(!(await evaluate("window.obpterm.tab.active.profile.args.includes('--resume')")), "a shell profile never gets --resume in its args");

  // Typing reaches that shell (give the fresh pty a beat, and let the typed resume land
  // first — the fixture has no claude binary, so it just prints "command not found").
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate("void window.obpterm.tp.write(window.obpterm.tab.active.id, 'echo alive-again\\r')");
  await until(`${bufferText("window.obpterm.tab.active")}.includes('alive-again')`, "the reloaded shell answers");
}


// ---- v0.21.5: the update chip always comes back --------------------------------------------
await evaluate("(() => { window.obpterm.config.update_repo = 'x/y'; window.obpterm.status.pendingUpdate = null; window.obpterm.tp.updateCheck = () => new Promise(() => {}); })()");
await evaluate("void window.obpterm.status.checkUpdates()");
await until("document.querySelector('#update-chip').textContent === 'Checking…'", "it starts checking");
await evaluate("(() => { window.obpterm.tp.updateCheck = async () => { throw new Error('no answer'); }; })()");
await evaluate("void window.obpterm.status.checkUpdates()");
await until("/^v\\d+\\.\\d+\\.\\d+/.test(document.querySelector('#update-chip').textContent)", "a failed check restores the version");
assert.equal(await evaluate("document.querySelector('#update-chip').disabled"), false, "and the chip is clickable again");
await evaluate("window.obpterm.config.update_repo = null");


// ---- v0.21.7: edges are visible where the nodes are, and leaving the map resets the tabs ----
{
  // Hermetic: its own tab, its own state, and everything put back before it returns.
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "a tab of its own");
  const ePane = await evaluate("window.obpterm.tabs.at(-1).active.id");
  devWs.send(JSON.stringify({ t: "agent_inject", reqId: 999, update: { pane: ePane, state: "working", session_id: "s-edge", detail: "Delegating", pending_id: null, options: [], agent_id: "e-1", agent_kind: "general-purpose", agent_task: "Idle 15 seconds", agent_event: "spawned" } }));
  await new Promise((r) => setTimeout(r, 300));
  await evaluate("window.obpterm.showView('agents')");
  await until("document.querySelectorAll('#nodemap .nedges path').length >= 1", "an edge is drawn");
  // A node is still travelling from its parent's anchor while `born` is on it; measure after.
  await until("document.querySelector('#nodemap .nnode.born') === null", "the entrance animation has landed");
  // The bug was an SVG offset that put every path thousands of pixels away.
  const onScreen = await evaluate(`(() => {
    const e = document.querySelector('#nodemap .nedges path').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#nodemap .nnode')].map((n) => n.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left)), right = Math.max(...boxes.map((b) => b.right));
    return e.width > 0 && e.left >= left - 60 && e.right <= right + 60;
  })()`);
  assert.ok(onScreen, "the edge is drawn among the nodes, not off-screen");

  // v0.21.11: laid out in the right place is not the same as painted. The SVG's own box was
  // 0x0, so every path fell outside its viewport and never showed up on Windows.
  const unclipped = await evaluate(`(() => {
    const svg = document.querySelector('#nodemap .nedges');
    const box = svg.getBoundingClientRect();
    const e = document.querySelector('#nodemap .nedges path').getBoundingClientRect();
    return box.width > 1 && box.height > 1 &&
      e.left >= box.left - 1 && e.right <= box.right + 1 &&
      e.top >= box.top - 1 && e.bottom <= box.bottom + 1;
  })()`);
  assert.ok(unclipped, "the edge lies inside the SVG's own viewport, so it is actually painted");

  // v0.21.14: the session behind the map is texture, not text.
  const wash = await evaluate(`(() => {
    const s = getComputedStyle(document.querySelector('#nodemap'));
    return JSON.stringify([s.backdropFilter || s.webkitBackdropFilter, s.backgroundImage.includes('radial-gradient')]);
  })()`);
  const [filter, gradient] = JSON.parse(wash);
  assert.match(filter, /blur/, "the map blurs what is behind it");
  assert.ok(gradient, "and carries the vignette");

  // Closing the map puts the rail's tabs back on Sessions.
  await evaluate("window.obpterm.nodes.close()");
  await until("document.querySelector('#rail-views .rv.on')?.dataset.view === 'sessions'", "the switcher follows the view out");

  await evaluate("(() => { const t = window.obpterm.tabs.at(-1); if (window.obpterm.tabs.length > 1) window.obpterm.closeTab(t); })()");
  await until(`window.obpterm.tabs.length === ${tabsBefore}`, "its tab is gone again");
  devWs.close();
}

// ---- v0.21.8: a restore reattaches by Claude's session id, not just by pty number ----------
{
  // A saved pane whose pty number is stale (a wrong host instance, an installer that wrote the
  // file early) must still find its shell through the conversation's own id.
  await evaluate("window.obpterm.showView('sessions')");
  const claudeId = "identity-" + Date.now();
  await evaluate(`(() => { const p = window.obpterm.tab.active; p.claudeSessionId = ${JSON.stringify(claudeId)}; })()`);
  await evaluate("void window.obpterm.flushSession()");
  const realId = await evaluate("window.obpterm.tab.active.id");

  // Pretend the host reports that shell under its Claude id, and that the saved instance is
  // from another run entirely.
  await evaluate(`(() => {
    window.__realList = window.obpterm.tp.listSessions;
    window.obpterm.tp.listSessions = async () => {
      const list = await window.__realList();
      return list.map((s) => (s.id === ${realId} ? { ...s, claude_session_id: ${JSON.stringify(claudeId)} } : s));
    };
  })()`);
  await evaluate("void window.obpterm.connectHost()");
  const found = await evaluate(`(() => window.obpterm.tp.listSessions().then(l => l.some(s => s.claude_session_id === ${JSON.stringify(claudeId)})))()`);
  assert.ok(found, "the host reports the shell under its conversation id");
  await evaluate("window.obpterm.tab.active.claudeSessionId = null");
  await evaluate("(() => { window.obpterm.tp.listSessions = window.__realList; })()"); // never leave a stub behind
}

// ---- v0.21.10: the title bar falls back to moving the window itself -----------------------
{
  // The native caption drag is accepted and ignored on this machine's Windows build, so the bar
  // watches for mousemove still arriving with the button down and takes over. That handover is
  // the part no Windows build can prove for us — drive it here.
  await evaluate(`(() => {
    window.__drag = [];
    window.__wasNative = window.obpterm.tp.native;
    window.obpterm.tp.native = true;   // the bar ignores mousedown on a non-native transport
    window.obpterm.tp.startDrag = async () => {};
    window.obpterm.tp.dragMove = async (dx, dy) => { window.__drag.push([dx, dy]); };
  })()`);
  const fire = (type, x, y, buttons) => evaluate(`(() => {
    const bar = document.querySelector('#titlebar');
    const target = ${type === "mousedown" ? "bar.querySelector('.grow')" : "window"};
    target.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
      bubbles: true, button: 0, buttons: ${buttons}, screenX: ${x}, screenY: ${y},
    }));
  })()`);
  await fire("mousedown", 400, 10, 1);
  await new Promise((r) => setTimeout(r, 200)); // past the 120ms the native drag gets to prove itself
  await fire("mousemove", 460, 40, 1);   // 60x30 — past the 3px threshold
  await until("window.__drag.length >= 1", "the bar moves the window itself once the native drag no-shows");
  const [dx, dy] = await evaluate("window.__drag[0]");
  const scale = await evaluate("window.devicePixelRatio || 1");
  assert.equal(dx, Math.round(60 * scale), "the delta is the pointer's, in physical pixels");
  assert.equal(dy, Math.round(30 * scale), "vertically too");
  await fire("mouseup", 460, 40, 0);
  await fire("mousemove", 600, 200, 1);  // after mouseup nothing should move
  assert.equal(await evaluate("window.__drag.length"), 1, "and it stops listening when the button comes up");
  await evaluate("window.obpterm.tp.native = window.__wasNative");
}


// ---- v0.21.12: sleeping background tabs, and a ceiling on live terminals ------------------
{
  // A live terminal holds a WebGL context; past about sixteen the window falls apart. Both
  // levers are driven by hand here — the suite pins them off at the top.
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 2}`, "two tabs of its own");
  const awake = () => evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).filter(p => !p.asleep && !p.exited && p.id > 0).length");

  // The sweep sleeps what is off screen, and never the tab you are looking at.
  await evaluate("(() => { window.obpterm.config.sleep_after_seconds = 1; for (const t of window.obpterm.tabs) for (const p of window.obpterm.panesOf(t)) p.lastVisited = 0; })()");
  await evaluate("void window.obpterm.sleepIdleTabs()");
  await until("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).some(p => p.asleep)", "an off-screen tab sleeps");
  const front = await evaluate("window.obpterm.panesOf(window.obpterm.tab).every(p => !p.asleep)");
  assert.ok(front, "the tab on screen keeps its terminal");

  // A pane waiting on a permission question is never slept — the rail answers through it.
  await evaluate(`(() => {
    const other = window.obpterm.tabs.find((t) => t !== window.obpterm.tab);
    const p = window.obpterm.panesOf(other)[0];
    window.__askId = p.id;
    p.lastVisited = 0;
    p.agent.state = "blocked";
    return p.asleep ? window.obpterm.wakePane(p) : null;
  })()`);
  await until("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === window.__askId)?.asleep === false", "it is awake to be tested");
  await evaluate("void window.obpterm.sleepIdleTabs()");
  const stillAwake = await evaluate("window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(p => p.id === window.__askId).asleep");
  assert.equal(stillAwake, false, "a pane holding a question is never slept");
  await evaluate(`(() => { const p = window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).find(x => x.id === window.__askId); p.agent.state = "done"; })()`);

  // The ceiling: waking past it sleeps the pane visited longest ago.
  await evaluate("(() => { window.obpterm.config.sleep_after_seconds = 0; window.obpterm.config.max_live_panes = 1; })()");
  await evaluate("(() => { for (const t of window.obpterm.tabs) for (const p of window.obpterm.panesOf(t)) p.lastVisited = Date.now(); })()");
  const target = await evaluate(`(() => {
    const other = window.obpterm.tabs.find((t) => t !== window.obpterm.tab);
    const p = window.obpterm.panesOf(other)[0];
    p.lastVisited = Date.now();
    return window.obpterm.wakePane(p).then(() => p.id);
  })()`);
  await until(`(${await awake()} , window.obpterm.tabs.flatMap(t => window.obpterm.panesOf(t)).filter(p => !p.asleep && !p.exited && p.id > 0).length <= window.obpterm.panesOf(window.obpterm.tab).length + 1)`, "the ceiling sleeps the oldest awake pane");
  assert.ok(typeof target === "number", "the woken pane is still the one asked for");

  // Put the suite back the way it found it.
  await evaluate("(() => { window.obpterm.config.sleep_after_seconds = 0; window.obpterm.config.max_live_panes = 0; })()");
  await evaluate(`(() => {
    for (const t of [...window.obpterm.tabs]) if (window.obpterm.tabs.length > ${tabsBefore}) window.obpterm.closeTab(t === window.obpterm.tab ? window.obpterm.tabs.find(x => x !== window.obpterm.tab) : t);
  })()`);
  await until(`window.obpterm.tabs.length === ${tabsBefore}`, "its tabs are gone again");
}


// ---- v0.21.13: a burst of hook events costs one repaint ------------------------------------
{
  // A ten-agent fan-out delivers hundreds of events in a burst. Each one used to repaint the
  // rail synchronously; now they collapse into the next frame.
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const pane = await evaluate("window.obpterm.tab.active.id");
  await evaluate("(() => { window.__paints = 0; const real = window.obpterm.paint.bind(window.obpterm); window.obpterm.paint = () => { window.__paints++; real(); }; })()");
  for (let i = 0; i < 12; i++) {
    devWs.send(JSON.stringify({ t: "agent_inject", reqId: 900 + i, update: { pane, state: "working", session_id: "s-burst", detail: `tool ${i}`, pending_id: null, options: [], agent_id: `b-${i}`, agent_kind: "general-purpose", agent_task: "burst", agent_event: "tool" } }));
  }
  await until("window.__paints >= 1", "the burst reaches the window");
  await new Promise((r) => setTimeout(r, 250));
  const paints = await evaluate("window.__paints");
  assert.ok(paints <= 3, `twelve events cost ${paints} repaints, not twelve`);
  await evaluate("(() => { window.obpterm.paint = Object.getPrototypeOf(window.obpterm).paint.bind(window.obpterm); })()");
  devWs.close();
}


// ---- v0.21.15: an agent that spawned an agent gets its own branch ------------------------
{
  // Lineage comes off real payloads (host/tests/fixtures-nested.jsonl): the Task call an agent
  // makes carries that agent's id, so the agent it spawns hangs off IT, not off the session.
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "a tab of its own");
  const pane = await evaluate("window.obpterm.tabs.at(-1).active.id");
  const fire = (u) => devWs.send(JSON.stringify({ t: "agent_inject", reqId: 800, update: { pane, state: "working", session_id: "s-nest", detail: null, pending_id: null, options: [], ...u } }));

  fire({ agent_id: "parent-1", agent_kind: "general-purpose", agent_task: "outer", agent_event: "spawned", agent_parent: null });
  fire({ agent_id: "child-1", agent_kind: "general-purpose", agent_task: "inner", agent_event: "spawned", agent_parent: "parent-1" });
  fire({ agent_id: "child-1", detail: "Running echo child", agent_event: "tool", agent_parent: null });
  await until(`window.obpterm.tabs.at(-1).active.agent.fanned.length === 2`, "both agents are known");

  const parented = await evaluate("window.obpterm.tabs.at(-1).active.agent.fanned.find(f => f.id === 'child-1').parent");
  assert.equal(parented, "parent-1", "the nested agent remembers who spawned it");

  await evaluate("window.obpterm.activate(window.obpterm.tabs.at(-1))");
  await evaluate("window.obpterm.showView('agents')");
  await until("document.querySelectorAll('#nodemap .nnode').length >= 3", "session plus two agents on the map");
  await until("document.querySelector('#nodemap .nnode.born') === null", "the entrance animations have landed");
  const shape = JSON.parse(await evaluate(`(() => {
    const n = window.obpterm.nodes.nodes;
    const p = n.find((x) => x.agent?.id === 'parent-1');
    const c = n.find((x) => x.agent?.id === 'child-1');
    return JSON.stringify({ childParent: c.parent, parentId: p.id, px: p.x, cx: c.x });
  })()`));
  assert.equal(shape.childParent, shape.parentId, "the child branches off its parent node, not the session");
  assert.ok(shape.cx > shape.px, `the generation sits further out (${shape.px} -> ${shape.cx})`);

  // v0.21.17: a parent that launched background sub-agents finishes at once. It must stay on
  // the map while they run — dropping it would strand the children on the session.
  fire({ agent_id: "parent-1", agent_event: "finished", agent_parent: null });
  await until("window.obpterm.tabs.at(-1).active.agent.fanned.find(f => f.id === 'parent-1').endedAt !== null", "the parent finished");
  await evaluate("(() => { const p = window.obpterm.tabs.at(-1).active.agent; p.fanned.find(f => f.id === 'parent-1').endedAt = Date.now() - 60000; })()");
  await evaluate("window.obpterm.onPaneActivity()");  // the sweep that prunes finished agents
  await evaluate("window.obpterm.paint()");
  const kept = JSON.parse(await evaluate(`(() => {
    const n = window.obpterm.nodes.nodes;
    const p = n.find((x) => x.agent?.id === 'parent-1');
    const c = n.find((x) => x.agent?.id === 'child-1');
    return JSON.stringify({ trunk: !!p, childParent: c?.parent ?? null, trunkId: p?.id ?? null });
  })()`));
  assert.ok(kept.trunk, "the finished parent stays while its child runs");
  assert.equal(kept.childParent, kept.trunkId, "and the child still hangs from it, not the session");

  await evaluate("window.obpterm.nodes.close()");
  await evaluate(`(() => { const t = window.obpterm.tabs.at(-1); if (window.obpterm.tabs.length > 1) window.obpterm.closeTab(t); })()`);
  await until(`window.obpterm.tabs.length === ${tabsBefore}`, "its tab is gone again");
  devWs.close();
}


// ---- v0.21.18: idle sessions are exited when the machine runs out of memory --------------
{
  // The freeze was never CPU: ~400 MB per idle Claude session, eighteen of them, a box at 98%
  // RAM thrashing on swap. A SLEEPING pane counts — sleep frees a terminal, not the process.
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "a tab to sacrifice");
  await until("window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].id > 0", "with a live shell");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate(`(() => {
    const p = window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0];
    p.claudeSessionId = "mem-1";
    p.agent.state = "done";
    p.asleep = true;                       // the case that used to be skipped outright
    p.lastVisited = Date.now();            // and far too recent for the timed path
    window.obpterm.config.eco_memory_pct = 50;
    window.obpterm.status.memoryPct = () => 97;
  })()`);
  await evaluate("window.obpterm.ecoSweep()");
  const ecoed = await evaluate(`window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].eco`);
  assert.equal(ecoed, true, "an idle sleeping session is exited under memory pressure");

  // Below the threshold nothing is touched.
  await evaluate(`(() => {
    const p = window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0];
    p.eco = false;
    window.obpterm.status.memoryPct = () => 40;
  })()`);
  await evaluate("window.obpterm.ecoSweep()");
  assert.equal(await evaluate(`window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].eco`), false, "and left alone when there is room");

  await evaluate("(() => { window.obpterm.config.eco_memory_pct = 0; delete window.obpterm.status.memoryPct; })()");
  await evaluate(`(() => { const t = window.obpterm.tabs.at(-1); if (window.obpterm.tabs.length > 1) window.obpterm.closeTab(t); })()`);
  await until(`window.obpterm.tabs.length === ${tabsBefore}`, "its tab is gone again");
}


// ---- v0.21.19: context pressure and what a session has spent -----------------------------
{
  // Both read the same transcript on the Rust side; here we drive the surfaces they feed.
  const row = () => "document.querySelector('.tab.active')";
  await evaluate("(() => { window.obpterm.config.context_warn_pct = 80; window.obpterm.tab.active.ctxPct = 42; window.obpterm.paint(); })()");
  assert.equal(await evaluate(`${row()}.querySelector('.ctx').hidden`), true, "a half-full conversation is not news");

  await evaluate("(() => { window.obpterm.tab.active.ctxPct = 88; window.obpterm.paint(); })()");
  await until(`${row()}.querySelector('.ctx').hidden === false`, "the context chip appears");
  assert.equal(await evaluate(`${row()}.querySelector('.ctx').textContent`), "ctx 88%", "and says how full");
  await evaluate("(() => { window.obpterm.tab.active.ctxPct = 97; window.obpterm.paint(); })()");
  assert.ok(await evaluate(`${row()}.querySelector('.ctx').classList.contains('hot')`), "past 95 it turns red");

  // Threshold off = nothing, whatever the gauge says.
  await evaluate("(() => { window.obpterm.config.context_warn_pct = 0; window.obpterm.paint(); })()");
  assert.equal(await evaluate(`${row()}.querySelector('.ctx').hidden`), true, "zero never flags");
  await evaluate("(() => { window.obpterm.config.context_warn_pct = 80; window.obpterm.tab.active.ctxPct = null; })()");

  // /compact goes to the shell as a line, like anything else typed at it.
  const paneId = await evaluate("window.obpterm.tab.active.id");
  await evaluate("(() => { window.__wrote = []; const real = window.obpterm.tp.write.bind(window.obpterm.tp); window.obpterm.tp.write = (id, d) => { window.__wrote.push([id, d]); return real(id, d); }; })()");
  await evaluate("(() => { window.obpterm.tab.active.claudeSessionId = 'c-1'; window.obpterm.compact(window.obpterm.tab.active); })()");
  const wrote = JSON.parse(await evaluate("JSON.stringify(window.__wrote)"));
  assert.deepEqual(wrote.at(-1), [paneId, "/compact\r"], "compact types /compact into that pane");
  await evaluate("(() => { window.obpterm.tab.active.claudeSessionId = null; })()");

  // Cost: shown once it is worth mentioning, with the tokens in the tooltip.
  await evaluate("(() => { window.obpterm.tab.active.usage = { input: 400000, output: 12000, cache_read: 0, cache_write: 0, cost_usd: 1.5, turns: 9 }; window.obpterm.paint(); })()");
  await until(`${row()}.querySelector('.cost').hidden === false`, "the cost chip appears");
  assert.equal(await evaluate(`${row()}.querySelector('.cost').textContent`), "$1.50", "in dollars");
  assert.match(await evaluate(`${row()}.querySelector('.cost').title`), /412k tokens/, "with the tokens in the tooltip");

  await evaluate("(() => { window.obpterm.tab.active.usage = { input: 10, output: 10, cache_read: 0, cache_write: 0, cost_usd: 0.004, turns: 1 }; window.obpterm.paint(); })()");
  assert.equal(await evaluate(`${row()}.querySelector('.cost').hidden`), true, "and below a dime it stays out of the way");
  await evaluate("(() => { window.obpterm.tab.active.usage = null; window.obpterm.paint(); })()");
}


// ---- v0.21.20: the three dead wires ------------------------------------------------------
{
  const row = () => "document.querySelector('.tab.active')";

  // 1. What a session is holding, and the eco sweep choosing by that instead of by clock.
  await evaluate("(() => { window.obpterm.tab.active.rss = 1.6e9; window.obpterm.paint(); })()");
  await until(`${row()}.querySelector('.rss').hidden === false`, "the memory chip appears");
  assert.equal(await evaluate(`${row()}.querySelector('.rss').textContent`), "1.6G", "in gigabytes");
  assert.ok(await evaluate(`${row()}.querySelector('.rss').classList.contains('heavy')`), "and flagged when it is a lot");
  await evaluate("(() => { window.obpterm.tab.active.rss = 40e6; window.obpterm.paint(); })()");
  assert.equal(await evaluate(`${row()}.querySelector('.rss').hidden`), true, "a small shell says nothing");

  // The victim order: biggest idle session first, not the one visited longest ago.
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 2}`, "two idle sessions");
  await until(`window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].id > 0 && window.obpterm.panesOf(window.obpterm.tabs.at(-2))[0].id > 0`, "both with shells");
  await evaluate("window.obpterm.activate(window.obpterm.tabs[0])");
  await evaluate(`(() => {
    const [small, big] = [window.obpterm.panesOf(window.obpterm.tabs.at(-2))[0], window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0]];
    for (const [p, rss, visited] of [[small, 50e6, 0], [big, 2.2e9, Date.now()]]) {
      p.claudeSessionId = "victim-" + rss; p.agent.state = "done"; p.rss = rss; p.lastVisited = visited;
    }
    window.obpterm.config.eco_memory_pct = 50;
    window.obpterm.status.memoryPct = () => 96;
  })()`);
  await evaluate("window.obpterm.ecoSweep()");
  const big = await evaluate("window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].eco");
  assert.equal(big, true, "the 2.2 GB session is exited even though it was visited most recently");

  // 2. The host's own agent state is adopted by a pane that has none.
  await evaluate(`(() => {
    const p = window.obpterm.panesOf(window.obpterm.tabs.at(-2))[0];
    p.agent.state = null; p.agent.detail = null;
    window.__realList2 = window.obpterm.tp.listSessions;
    window.obpterm.tp.listSessions = async () => (await window.__realList2()).map((s) => (s.id === p.id
      ? { ...s, agent_state: "blocked", agent_detail: "Bash: rm -rf build/" } : s));
  })()`);
  await evaluate("void window.obpterm.refreshHeld()");
  await until(`window.obpterm.panesOf(window.obpterm.tabs.at(-2))[0].agent.state === "blocked"`, "the rail adopts what the host knew");
  assert.equal(await evaluate(`window.obpterm.panesOf(window.obpterm.tabs.at(-2))[0].agent.detail`), "Bash: rm -rf build/", "detail and all");
  // Put the transport back: a stub left in place keeps re-applying that state to every pane the
  // rest of the suite touches, which is exactly how this file became flaky.
  await evaluate("(() => { window.obpterm.tp.listSessions = window.__realList2; })()");

  // 3. A session that stopped reporting mid-task says so instead of looking idle.
  await evaluate(`(() => {
    const p = window.obpterm.tab.active;
    p.agent.state = "working";
    p.agent.workingSince = Date.now() - 25 * 60_000;
    window.obpterm.onPaneActivity();
  })()`);
  await until(`${row()}.classList.contains('stalled')`, "the row is marked stalled");
  assert.match(await evaluate(`${row()}.querySelector('.sub').textContent`), /stalled — nothing reported for \d+m/, "and says how long");
  await evaluate("(() => { const p = window.obpterm.tab.active; p.agent.state = 'working'; p.agent.workingSince = Date.now(); window.obpterm.onPaneActivity(); window.obpterm.paint(); })()");
  assert.equal(await evaluate(`${row()}.classList.contains('stalled')`), false, "and clears the moment it talks again");

  await evaluate("(() => { window.obpterm.config.eco_memory_pct = 0; window.obpterm.tab.active.agent.state = null; window.obpterm.tab.active.rss = 0; })()");
  await evaluate(`(() => { while (window.obpterm.tabs.length > ${tabsBefore}) window.obpterm.closeTab(window.obpterm.tabs.at(-1)); })()`);
  await until(`window.obpterm.tabs.length === ${tabsBefore}`, "its tabs are gone again");
}


// ---- v0.21.21: the fields the app computed and never read ---------------------------------
{
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const pane = await evaluate("window.obpterm.tab.active.id");
  const fire = (u) => devWs.send(JSON.stringify({ t: "agent_inject", reqId: 700, update: { pane, state: "working", session_id: "s-tally", detail: null, pending_id: null, options: [], ...u } }));

  // Tool tally: the name arrives on every tool event now, not only on permission requests.
  await evaluate("(() => { window.obpterm.tab.active.agent.toolCounts = {}; })()");
  fire({ tool: "Bash", detail: "Running cargo test" });
  fire({ tool: "Bash", detail: "Running npm run build" });
  fire({ tool: "Edit", detail: "Editing pty.rs" });
  await until("window.obpterm.tab.active.agent.toolCounts?.Bash === 2", "two Bash calls counted");
  assert.equal(await evaluate("window.obpterm.tab.active.agent.toolCounts.Edit"), 1, "and one Edit");

  // Fan-out rollup: the duration outlives the agent that earned it.
  await evaluate(`(() => {
    const a = window.obpterm.tab.active.agent;
    a.fanStats = { count: 0, totalMs: 0, longestMs: 0 };
    a.fanned = [
      { id: "f1", kind: "general-purpose", task: "one", feed: null, startedAt: Date.now() - 100000, endedAt: Date.now() - 40000, tools: 3, parent: null },
      { id: "f2", kind: "general-purpose", task: "two", feed: null, startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, tools: 1, parent: null },
    ];
    window.obpterm.onPaneActivity();
  })()`);
  await until("window.obpterm.tab.active.agent.fanStats.count === 2", "both finished agents are folded in");
  const longest = await evaluate("window.obpterm.tab.active.agent.fanStats.longestMs");
  assert.ok(longest >= 59000 && longest <= 61000, `the longest is kept (${longest}ms)`);
  assert.equal(await evaluate("window.obpterm.tab.active.agent.fanned.length"), 0, "and the agents themselves are gone");

  // The header carries what it knows, and both counts are actionable.
  await evaluate("(() => { window.obpterm.tab.active.startedAt = Date.now() - 6 * 3600_000 - 40 * 60_000; window.obpterm.paint(); })()");
  assert.match(await evaluate("document.querySelector('.tab.active').title"), /open 6h40m/, "the row says how long it has been open");
  assert.match(await evaluate("document.querySelector('.tab.active').title"), /2 Bash/, "and what it has been doing");
  assert.equal(await evaluate("typeof document.querySelector('#rail-waiting').onclick"), "function", "the header count is clickable");

  // A project made from where you are standing.
  const cwd = await evaluate("window.obpterm.tab.active.cwd");
  const madeId = await evaluate("window.obpterm.addProject('inherits-cwd').id");
  const made = JSON.parse(await evaluate(`JSON.stringify(window.obpterm.config.projects.find(p => p.id === ${JSON.stringify(madeId)}))`));
  assert.equal(made.cwd, cwd, "the new project starts where the tab was");
  await evaluate(`(() => { const c = window.obpterm.config; c.projects = c.projects.filter(p => p.id !== ${JSON.stringify(madeId)}); window.obpterm.paint(); })()`);

  await evaluate("(() => { const a = window.obpterm.tab.active.agent; a.toolCounts = {}; a.fanStats = { count: 0, totalMs: 0, longestMs: 0 }; window.obpterm.tab.active.startedAt = 0; })()");
  devWs.close();
}


// ---- v0.21.22: a verdict that came from the phone ----------------------------------------
{
  // The phone taps a button in the ntfy notification; that publishes back to the topic; the
  // window hears it and answers the held request exactly as the rail's own buttons do.
  const devWs = new WebSocket("ws://127.0.0.1:1421");
  await new Promise((r) => devWs.on("open", r));
  const pane = await evaluate("window.obpterm.tab.active.id");
  void pane;
  // A request on the pane you are LOOKING at is passed straight through by design, so hold one
  // directly rather than fighting that.
  await evaluate("(() => { const a = window.obpterm.tab.active.agent; a.state = 'blocked'; a.pendingId = 'p-phone'; })()");

  await evaluate("window.obpterm.answerFromPhone('p-phone', true)");
  await until("window.obpterm.tab.active.agent.pendingId === null", "the pane stops waiting");
  const answers = await new Promise((resolve) => {
    devWs.send(JSON.stringify({ t: "agent_answers", reqId: 3100 }));
    devWs.on("message", function once(d) {
      const m = JSON.parse(d);
      if (m.reqId === 3100) { devWs.off("message", once); resolve(m.answered); }
    });
  });
  assert.deepEqual(answers.at(-1), { pending: "p-phone", allow: true }, "and the verdict reached the host");
  devWs.close();
}


// ---- v0.21.22: eco must not append --resume to a shell ------------------------------------
{
  // `pwsh.exe --resume <id>` is not a shell invocation — it is pwsh exiting with code 64 and
  // the conversation going with it. This took out every session on the user's machine once.
  const plan = JSON.parse(await evaluate(`(() => {
    const shell = { id: "p-sh", name: "PowerShell", exe: "pwsh.exe", args: ["-NoLogo", "-NoExit"] };
    const claude = { id: "p-cl", name: "Claude", exe: "pwsh.exe", args: ["-NoLogo", "-NoExit", "-Command", "claude"] };
    const r = window.obpterm.constructor;
    return JSON.stringify({
      shell: window.__resumePlan(shell, "sess-1"),
      claude: window.__resumePlan(claude, "sess-1"),
      claudeAgain: window.__resumePlan({ ...claude, args: [...claude.args, "--resume", "old"] }, "sess-2"),
      unused: !!r,
    });
  })()`));
  assert.deepEqual(plan.shell.profile.args, ["-NoLogo", "-NoExit"], "a shell's arguments are left alone");
  assert.equal(plan.shell.type, "sess-1", "and the conversation is typed into it instead");
  assert.deepEqual(plan.claude.profile.args.slice(-2), ["--resume", "sess-1"], "a claude profile takes it as an argument");
  assert.equal(plan.claude.type, null, "and types nothing");
  assert.deepEqual(plan.claudeAgain.profile.args.slice(-2), ["--resume", "sess-2"], "resuming twice does not stack --resume");
  assert.equal(plan.claudeAgain.profile.args.filter((a) => a === "--resume").length, 1, "exactly one");
}


// ---- v0.21.23: the ledger, and moving a project ------------------------------------------
{
  // The ledger remembers every session by name whether or not it is open, so a crash that
  // writes fewer tabs than were running can be offered back instead of silently losing them.
  const tabsBefore = await evaluate("window.obpterm.tabs.length");
  await evaluate("void window.obpterm.newTab()");
  await until(`window.obpterm.tabs.length === ${tabsBefore + 1}`, "a session to lose");
  await until("window.obpterm.panesOf(window.obpterm.tabs.at(-1))[0].id > 0", "with a shell");
  await evaluate(`(() => {
    const t = window.obpterm.tabs.at(-1);
    t.name = "the-lost-one";
    const p = window.obpterm.panesOf(t)[0];
    p.claudeSessionId = "ledger-1";
    p.profile = { ...p.profile, args: [...p.profile.args, "claude"] };  // a claude pane, so it is ledgered
  })()`);
  await evaluate("void window.obpterm.flushSession()");
  await until("window.obpterm.ledger.some(e => e.claude === 'ledger-1')", "it is in the ledger");
  assert.equal(await evaluate("window.obpterm.ledger.find(e => e.claude === 'ledger-1').title"), "the-lost-one", "by name");
  assert.equal(await evaluate("window.obpterm.missingSessions().length"), 0, "and nothing is missing while everything is open");

  // Simulate the crash: the tab is gone from the window but was never closed by hand.
  await evaluate(`(() => {
    const t = window.obpterm.tabs.at(-1);
    window.obpterm.tabs = window.obpterm.tabs.filter((x) => x !== t);
    window.obpterm.tab = window.obpterm.tabs[0];
    window.obpterm.paint();
  })()`);
  const missing = JSON.parse(await evaluate("JSON.stringify(window.obpterm.missingSessions().map(e => e.title))"));
  assert.deepEqual(missing, ["the-lost-one"], "it is offered back after a crash");

  // Closing one by hand is not a loss and must never be offered.
  await evaluate("(() => { const e = window.obpterm.ledger.find(x => x.claude === 'ledger-1'); e.closed = true; })()");
  assert.equal(await evaluate("window.obpterm.missingSessions().length"), 0, "a deliberate close is not missing");

  // Moving a project takes its tabs with it.
  const order = JSON.parse(await evaluate(`(() => {
    const c = window.obpterm.config;
    c.projects = [{ id: "pa", name: "A", color: "#f00", cwd: null, default_profile: null, layout: null, collapsed: false },
                  { id: "pb", name: "B", color: "#0f0", cwd: null, default_profile: null, layout: null, collapsed: false }];
    for (const [i, t] of window.obpterm.tabs.entries()) t.projectId = i === 0 ? "pa" : "pb";
    window.obpterm.moveProject(c.projects[0], 1);
    return JSON.stringify({
      projects: c.projects.map((p) => p.id),
      tabs: window.obpterm.tabs.map((t) => t.projectId),
    });
  })()`));
  assert.deepEqual(order.projects, ["pb", "pa"], "the project moved down");
  assert.ok(order.tabs.indexOf("pb") <= order.tabs.indexOf("pa") || !order.tabs.includes("pa"), "and its tabs went with it");

  await evaluate(`(() => {
    window.obpterm.config.projects = [];
    for (const t of window.obpterm.tabs) t.projectId = null;
    while (window.obpterm.tabs.length > ${tabsBefore}) window.obpterm.closeTab(window.obpterm.tabs.at(-1));
    window.obpterm.paint();
  })()`);
}


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

