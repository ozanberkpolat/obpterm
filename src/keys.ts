// App shortcuts (Windows Terminal muscle memory) + the browser accelerators that must never
// fire inside a terminal. The Rust side also turns WebView2's accelerator keys off; this is
// the belt to that braces, and the only guard in the browser dev loop.
import type { App } from "./app";
import { closeMenu, openMenu } from "./menu";
import { newProject, renameTab } from "./rail";

const ctrlShift = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
const ctrlOnly = (e: KeyboardEvent) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
const altOnly = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
const altShift = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;

/** Keys the app handles itself; xterm must not forward them to the pty. */
export function ownsKey(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return false;
  if (ctrlOnly(e) && e.code === "Tab") return true;
  if (ctrlShift(e) && ["Tab", "KeyT", "KeyW", "KeyB", "KeyC", "KeyV", "KeyF", "KeyL", "KeyP", "KeyN", "KeyH", "KeyQ", "Comma", "ArrowUp", "ArrowDown"].includes(e.code)) return true;
  if ((ctrlShift(e) || ctrlOnly(e)) && /^Digit[1-9]$/.test(e.code)) return true;
  if (ctrlOnly(e) && ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "KeyK", "KeyG"].includes(e.code)) return true;
  if ((altOnly(e) || altShift(e)) && e.code in ARROWS) return true;
  if (altShift(e) && ["Equal", "Minus", "NumpadAdd", "NumpadSubtract", "KeyD"].includes(e.code)) return true;
  if (e.code === "F2") return true; // rename, not a key any shell here uses
  return e.code === "F12"; // F5 is a real key for the shell (ESC[15~); only devtools is ours
}

export function installKeys(app: App) {
  window.addEventListener(
    "keydown",
    (e) => {
      // A text field owns its keystrokes. The listener is on the window in the capture phase,
      // so a stopPropagation() inside the field can never reach us — check the target instead.
      // xterm receives keys through a hidden textarea of its own, and that one is NOT a field:
      // treating it as one killed every shortcut while a pane had focus, which is always.
      const target = e.target as HTMLElement | null;
      const inTerminal = !!target?.closest?.(".xterm");
      if (!inTerminal && (target?.matches?.("input, textarea, select") || target?.isContentEditable)) {
        if (e.code === "F12") stop(e);
        return;
      }

      // Browser-only chords: swallow unconditionally (reload, devtools, print…)
      if (e.code === "F12" || (ctrlShift(e) && ["KeyI", "KeyJ", "KeyR"].includes(e.code))) return stop(e);
      if (e.code === "F5" && e.ctrlKey) return stop(e);
      if (e.code === "Escape") {
        closeMenu();
        if (app.deck.isOpen) {
          app.deck.close();
          return stop(e);
        }
        if (app.palette.isOpen) {
          app.palette.close();
          return stop(e);
        }
        if (app.settings.isOpen) {
          app.settings.close();
          return stop(e);
        }
      }

      if (ctrlOnly(e) && e.code === "Tab") { app.recent(); return stop(e); }
      if (ctrlShift(e) && e.code === "Tab") { app.cycle(-1); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyT") { void app.newTab(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyP") { profilePicker(app); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyN") { newProject(app); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyW") { closeActive(app); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyQ") { if (app.tab) app.closeTab(app.tab); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyB") { app.toggleRail(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyC") { void app.copy(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyV") { void app.paste(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyF") { app.find.open(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyL") { void app.toggleLog(); return stop(e); }
      if (ctrlShift(e) && e.code === "KeyH") { hostPicker(app); return stop(e); }
      if (e.code === "F2" && !e.ctrlKey && !e.altKey) { if (app.tab) renameTab(app, app.tab); return stop(e); }
      if (ctrlShift(e) && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
        if (app.tab) app.moveTab(app.tab, e.code === "ArrowUp" ? -1 : 1);
        return stop(e);
      }
      if (ctrlShift(e) && e.code === "Comma") { app.settings.open(); return stop(e); }
      if (ctrlOnly(e) && e.code === "KeyK") { app.palette.open(); return stop(e); }
      if (ctrlOnly(e) && e.code === "KeyG") { app.deck.toggle(); return stop(e); }

      // Panes: Alt+Shift splits and resizes, Alt alone moves focus (Windows Terminal's map).
      if (altShift(e) && ["Equal", "NumpadAdd"].includes(e.code)) { void app.splitPane("row"); return stop(e); }
      if (altShift(e) && ["Minus", "NumpadSubtract"].includes(e.code)) { void app.splitPane("col"); return stop(e); }
      if (altShift(e) && e.code === "KeyD") { void app.splitPane("row"); return stop(e); }
      if (altShift(e) && e.code in ARROWS) { app.resizePane(ARROWS[e.code as keyof typeof ARROWS]); return stop(e); }
      if (altOnly(e) && e.code in ARROWS) { app.moveFocus(ARROWS[e.code as keyof typeof ARROWS]); return stop(e); }

      const digit = e.ctrlKey && !e.altKey && !e.metaKey ? /^Digit([1-9])$/.exec(e.code) : null;
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

  document.addEventListener("click", () => closeMenu());
  document.querySelector("#rail-toggle")!.addEventListener("click", () => app.toggleRail());
  document.querySelector("#new-tab")!.addEventListener("click", () => void app.newTab());
  document.querySelector("#new-tab")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    profilePicker(app, e as MouseEvent);
  });
  document.querySelector("#new-project")!.addEventListener("click", () => newProject(app));

  // Ctrl+wheel zooms, the way every editor does — the terminal keeps its own scroll.
  document.querySelector("#panes")!.addEventListener(
    "wheel",
    (e) => {
      const ev = e as WheelEvent;
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      app.zoom(ev.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // Dragging the rail's edge resizes it; the width is remembered.
  const handle = document.querySelector<HTMLElement>("#rail-resize")!;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const move = (ev: PointerEvent) => app.setRailWidth(ev.clientX);
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  // Right-click in a pane: copy the selection if there is one, otherwise paste (WT behaviour).
  document.querySelector("#panes")!.addEventListener("contextmenu", (e) => {
    if (!app.config.right_click_paste) return;
    e.preventDefault();
    void app.copy().then((copied) => {
      if (!copied) void app.paste();
    });
  });
}

/** Ctrl+Shift+W closes the pane you are in, or the tab when it is the last one. */
function closeActive(app: App) {
  const tab = app.tab;
  if (!tab) return;
  app.closePane(tab.active, tab);
}

function profilePicker(app: App, e?: MouseEvent) {
  const anchor = document.querySelector("#new-tab")!.getBoundingClientRect();
  openMenu(e?.clientX ?? anchor.left, e?.clientY ?? anchor.top, [
    ...app.config.profiles.map((p, i) => ({
      label: p.name,
      hint: `Ctrl+Shift+${i + 1}`,
      onPick: () => void app.newTab(p),
    })),
    ...app.config.hosts.map((h) => ({
      label: h.name,
      hint: h.user ? `${h.user}@${h.host}` : h.host,
      onPick: () => void app.newTabForHost(h),
    })),
  ]);
}

function hostPicker(app: App) {
  const anchor = document.querySelector("#target-chip")!.getBoundingClientRect();
  if (!app.config.hosts.length) return app.settings.open("hosts");
  openMenu(
    anchor.left,
    anchor.top,
    app.config.hosts.map((h) => ({
      label: h.name,
      hint: h.user ? `${h.user}@${h.host}` : h.host,
      onPick: () => void app.newTabForHost(h),
    })),
  );
}

function stop(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}
