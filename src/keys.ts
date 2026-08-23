// App shortcuts (Windows Terminal muscle memory) + the browser accelerators that must never
// fire inside a terminal. The Rust side also turns WebView2's accelerator keys off; this is
// the belt to that braces, and the only guard in the browser dev loop.
import type { App } from "./app";

const ctrlShift = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
const ctrlOnly = (e: KeyboardEvent) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;

/** Keys the app handles itself; xterm must not forward them to the pty. */
export function ownsKey(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return false;
  if (ctrlOnly(e) && e.code === "Tab") return true;
  if (ctrlShift(e) && ["Tab", "KeyT", "KeyW", "KeyB", "KeyC", "KeyV"].includes(e.code)) return true;
  if ((ctrlShift(e) || ctrlOnly(e)) && /^Digit[1-9]$/.test(e.code)) return true;
  if (ctrlOnly(e) && ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract"].includes(e.code)) return true;
  return e.code === "F12"; // F5 is a real key for the shell (ESC[15~); only devtools is ours
}

export function installKeys(app: App) {
  window.addEventListener(
    "keydown",
    (e) => {
      // Browser-only chords: swallow unconditionally (reload, devtools, find, print, zoom…)
      if (e.code === "F12" || (ctrlShift(e) && ["KeyI", "KeyJ", "KeyR"].includes(e.code))) return stop(e);
      if (e.code === "F5" && e.ctrlKey) return stop(e);

      if (ctrlOnly(e) && e.code === "Tab") { app.cycle(1); return stop(e); }
      if (ctrlShift(e) && e.code === "Tab") { app.cycle(-1); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyT") { void app.newTab(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyW") { if (app.active) app.closeTab(app.active); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyB") { app.toggleRail(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyC") { void app.copy(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyV") { void app.paste(); return stop(e); }
      const digit = (e.ctrlKey && !e.altKey && !e.metaKey) ? /^Digit([1-9])$/.exec(e.code) : null;
      if (digit) {
        const n = Number(digit[1]) - 1;
        if (e.shiftKey) {
          const p = app.config.profiles[n];
          if (p) void app.newTab(p);
        } else app.jump(n);
        return stop(e);
      }
      if (ctrlOnly(e) && (e.code === "Equal" || e.code === "NumpadAdd")) { app.zoom(1); return stop(e); }
      if (ctrlOnly(e) && (e.code === "Minus" || e.code === "NumpadSubtract")) { app.zoom(-1); return stop(e); }
      if (ctrlOnly(e) && e.code === "Digit0") { app.zoom(0); return stop(e); }
    },
    { capture: true },
  );

  // Right-click: copy the selection if there is one, otherwise paste (Windows Terminal behaviour).
  document.querySelector("#panes")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void app.copy().then((copied) => { if (!copied) void app.paste(); });
  });
}

function stop(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}
