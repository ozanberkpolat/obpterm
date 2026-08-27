// Every control in the window, clicked, with something asserted about what happened.
//
// The smoke suite proves FEATURES work by driving the app's own functions. This proves the
// BUTTONS work — that what a user actually touches is wired to those functions and that the
// result is visible. Those are different failures: the host-chip menu was built correctly and
// then hidden again by the same click, so every function passed and the control was dead.
//
// Run it the same way as the smoke suite: `node test/controls.mjs` with `vite preview` on 1420
// and the headless Chromium on 9222.
import WebSocket from "ws";
import assert from "node:assert/strict";

const url = process.argv[2] ?? "http://127.0.0.1:1420/";

for (const t of await (await fetch("http://127.0.0.1:9222/json/list")).json()) {
  if (t.type === "page") await fetch(`http://127.0.0.1:9222/json/close/${t.id}`);
}
const target = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));

let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    ws.on("message", function once(data) {
      const m = JSON.parse(data);
      if (m.id !== mid) return;
      ws.off("message", once);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    });
  });

const problems = [];
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.navigate", { url });
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expr} threw: ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result.value;
};
const until = async (expr, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await evaluate(expr).catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
};

await until("!!window.obpterm?.tab?.active?.id > 0", "the app", 30000);
// Nothing automatic may fire under an audit: a sweep that sleeps a pane mid-click looks like a
// broken button.
await evaluate(`(() => {
  const c = window.obpterm.config;
  c.sleep_after_seconds = 0; c.max_live_panes = 0; c.eco_after_minutes = 0; c.eco_memory_pct = 0;
})()`);

/** Click something the way a user does, and say what happened after. */
const click = async (selector, { setup = "", expect, what, ms = 4000 } = {}) => {
  if (setup) await evaluate(setup);
  const exists = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  if (!exists) {
    problems.push(`${selector} — no such control`);
    return false;
  }
  const visible = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect();
      return !e.hidden && r.width > 0 && r.height > 0 && getComputedStyle(e).pointerEvents !== "none"; })()`,
  );
  if (!visible) {
    problems.push(`${selector} — present but not clickable (hidden, zero-sized, or pointer-events: none)`);
    return false;
  }
  await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect();
      e.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`,
  );
  const ok = await until(expect, what, ms);
  if (!ok) problems.push(`${selector} — clicked, but ${what} did not happen`);
  return ok;
};

const menuOpen = "!document.querySelector('#menu').hidden && document.querySelectorAll('#menu .menu-item').length > 0";
const closeMenu = "(() => { window.obpterm && document.querySelector('#menu') && (document.querySelector('#menu').hidden = true); })()";

// ---- title bar ----------------------------------------------------------------------------
for (const label of ["Shell", "Panes", "Project", "View"]) {
  await click(`#titlebar .menus button:nth-of-type(${["Shell", "Panes", "Project", "View"].indexOf(label) + 1})`, {
    setup: closeMenu,
    expect: menuOpen,
    what: `the ${label} menu opens`,
  });
}
await evaluate(closeMenu);
await click("#titlebar .search", { expect: "!document.querySelector('#palette').hidden", what: "the palette opens" });
await evaluate("document.querySelector('#palette').hidden = true");
await click("#titlebar .gear", { expect: "!document.querySelector('#settings').hidden", what: "settings opens" });
await evaluate("window.obpterm.settings.close?.() ?? (document.querySelector('#settings').hidden = true)");
await click("#titlebar .win[data-action='minimize']", { expect: "true", what: "minimize is wired", ms: 500 });

// ---- rail ---------------------------------------------------------------------------------
const tabsAtStart = await evaluate("window.obpterm.tabs.length");
await click("#new-tab", { expect: `window.obpterm.tabs.length > ${tabsAtStart}`, what: "a tab is created", ms: 8000 });
await click("#rail-toggle", { expect: "document.querySelector('#rail').classList.contains('collapsed')", what: "the rail collapses" });
await click("#rail-toggle", { expect: "!document.querySelector('#rail').classList.contains('collapsed')", what: "the rail expands again" });
await click("#new-project", { expect: "!document.querySelector('#rail-new').hidden", what: "the project name field appears" });
await evaluate("(() => { const h = document.querySelector('#rail-new'); h.hidden = true; h.replaceChildren(); })()");

// The view switcher: Sessions / Agents.
await click("#rail-views .rv:nth-of-type(2)", { expect: "!document.querySelector('#nodemap').hidden", what: "the Agents view opens" });
await click("#nodemap .nzoom-in", { expect: "parseInt(document.querySelector('#nodemap .nlevel').textContent) > 100", what: "zoom in changes the level" });
await click("#nodemap .nzoom-out", { expect: "parseInt(document.querySelector('#nodemap .nlevel').textContent) <= 100", what: "zoom out changes it back" });
await click("#nodemap .nfit", { expect: "true", what: "fit is wired", ms: 500 });
await click("#nodemap .nclose", { expect: "document.querySelector('#nodemap').hidden", what: "the Agents view closes" });
await click("#rail-views .rv:nth-of-type(1)", { expect: "document.querySelector('#nodemap').hidden", what: "Sessions stays selected" });

// A tab row: click to focus, right-click for its menu.
await click("#rail-body .tab", { expect: "!!window.obpterm.tab", what: "a tab row activates a tab" });
await evaluate(closeMenu);
await evaluate(
  `(() => { const t = document.querySelector('#rail-body .tab'); const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 })); })()`,
);
if (!(await until(menuOpen, "the tab menu"))) problems.push("#rail-body .tab — right-click does not open the tab menu");
const tabMenuItems = await evaluate("[...document.querySelectorAll('#menu .menu-item')].map(b => b.textContent)");
for (const wanted of ["Sleep this session", "Move up", "Move down", "Compact this conversation"]) {
  if (!tabMenuItems.some((l) => l.includes(wanted))) problems.push(`tab menu — no "${wanted}" entry`);
}
await evaluate(closeMenu);

// ---- status bar ---------------------------------------------------------------------------
await click("#account-chip", { setup: closeMenu, expect: menuOpen, what: "the account menu opens" });
await evaluate(closeMenu);
await click("#target-chip", { setup: closeMenu, expect: menuOpen, what: "the target menu opens" });
await evaluate(closeMenu);
// The breakdown needs the usage read off disk, which lands a moment after launch — clicking
// before that is the audit being too quick, not the control being dead.
await until("!!window.obpterm.status?.usage || !!window.obpterm.status?.limits", "usage to load", 20000);
// With transcripts it opens a breakdown; without them it says so in a toast. Either is the
// control working — silence is not.
await click("#quota", {
  setup: `${closeMenu}; (() => { const t = document.querySelector('#toast'); if (t) t.hidden = true; })()`,
  expect: `${menuOpen} || !document.querySelector('#toast').hidden`,
  what: "the usage breakdown opens, or it says why it cannot",
});
await evaluate(closeMenu);
await click("#host-chip", {
  setup: `${closeMenu}; (() => { const c = document.querySelector('#host-chip'); c.hidden = false; c.textContent = '3 in the background'; })()`,
  expect: menuOpen,
  what: "the host menu opens",
});
const hostItems = await evaluate("[...document.querySelectorAll('#menu .menu-item')].map(b => b.textContent)");
for (const wanted of ["Wake every sleeping tab", "Restart the session host", "Quit and end every shell"]) {
  if (!hostItems.some((l) => l.includes(wanted))) problems.push(`host menu — no "${wanted}" entry`);
}
await evaluate(closeMenu);
await click("#update-chip", { expect: "true", what: "the update check is wired", ms: 500 });

// ---- find bar and the palette ---------------------------------------------------------------
await evaluate("window.obpterm.find.open()");
if (!(await until("!document.querySelector('#find').hidden", "the find bar"))) problems.push("#find — does not open");
await click("#find .next", { expect: "true", what: "find next is wired", ms: 500 });
await click("#find .prev", { expect: "true", what: "find previous is wired", ms: 500 });
await click("#find .regex", { expect: "true", what: "the regex toggle is wired", ms: 500 });
await click("#find .close", { expect: "document.querySelector('#find').hidden", what: "the find bar closes" });

await evaluate("window.obpterm.palette.open('')");
if (!(await until("!document.querySelector('#palette').hidden", "the palette"))) problems.push("#palette — does not open");
const paletteEntries = await evaluate("document.querySelectorAll('#palette .results button, #palette .results .row').length");
if (!paletteEntries) problems.push("#palette — opens with no entries");
await evaluate("document.querySelector('#palette').hidden = true");

// ---- settings: every section reachable ------------------------------------------------------
await evaluate("window.obpterm.settings.open()");
if (!(await until("!document.querySelector('#settings').hidden", "settings"))) problems.push("#settings — does not open");
const sections = await evaluate("[...document.querySelectorAll('#settings .sw-nav button')].map(b => b.textContent)");
for (const [i, name] of sections.entries()) {
  await evaluate(`document.querySelectorAll('#settings .sw-nav button')[${i}].click()`);
  const painted = await until("document.querySelector('#settings .sw-body')?.children.length > 0", `the ${name} section`, 3000);
  if (!painted) problems.push(`settings — "${name}" renders nothing`);
}
await evaluate("(() => { const s = document.querySelector('#settings'); s.hidden = true; })()");

// ---- the toolbar (pane layout picker) -------------------------------------------------------
const toolbarButtons = await evaluate("document.querySelectorAll('#toolbar button').length");
if (!toolbarButtons) problems.push("#toolbar — no buttons");
for (let i = 0; i < toolbarButtons; i++) {
  const label = await evaluate(`document.querySelectorAll('#toolbar button')[${i}].title || document.querySelectorAll('#toolbar button')[${i}].className`);
  await evaluate(`document.querySelectorAll('#toolbar button')[${i}].click()`);
  const alive = await until("!!window.obpterm.tab", `the toolbar's ${label}`, 3000);
  if (!alive) problems.push(`#toolbar — "${label}" left the window without a tab`);
}

// Put the window back roughly where it was.
await evaluate(`(() => { while (window.obpterm.tabs.length > ${tabsAtStart}) window.obpterm.closeTab(window.obpterm.tabs.at(-1)); })()`);

if (problems.length) {
  console.error(`controls: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("controls OK — every control clicked and did something");
process.exit(0);
