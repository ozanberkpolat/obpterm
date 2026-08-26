// App shortcuts (Windows Terminal muscle memory) + the browser accelerators that must never
// fire inside a terminal. The Rust side also turns WebView2's accelerator keys off; this is
// the belt to that braces, and the only guard in the browser dev loop.
import type { App } from "./app";
import { closeMenu, openMenu } from "./menu";
import { actionFor } from "./keymap";

const ctrlShift = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
const ctrlOnly = (e: KeyboardEvent) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
const altOnly = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
const altShift = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;

/** Keys the app handles itself; xterm must not forward them to the pty. */
export function ownsKey(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return false;
  if (actionFor(e)) return true; // every rebindable chord, at its CURRENT binding
  if (ctrlShift(e) && ["ArrowUp", "ArrowDown"].includes(e.code)) return true;
  if ((ctrlShift(e) || ctrlOnly(e)) && /^Digit[1-9]$/.test(e.code)) return true;
  if (ctrlOnly(e) && ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract"].includes(e.code)) return true;
  if ((altOnly(e) || altShift(e)) && e.code in ARROWS) return true;
  if (altShift(e) && ["NumpadAdd", "NumpadSubtract", "KeyD"].includes(e.code)) return true;
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
        if (app.nodes.isOpen) {
          app.nodes.close();
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

      // Rebindable chords, at whatever the user bound them to.
      const action = actionFor(e);
      if (action) { action.run(app); return stop(e); }

      if (ctrlShift(e) && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
        if (app.tab) app.moveTab(app.tab, e.code === "ArrowUp" ? -1 : 1);
        return stop(e);
      }
      // Numpad aliases for the splits, and Windows Terminal's Alt+Shift+D.
      if (altShift(e) && e.code === "NumpadAdd") { void app.splitPane("row"); return stop(e); }
      if (altShift(e) && e.code === "NumpadSubtract") { void app.splitPane("col"); return stop(e); }
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
  document.querySelector("#new-project")!.addEventListener("click", () => void import("./rail").then((r) => r.newProject(app)));

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

export function profilePicker(app: App, e?: MouseEvent) {
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

export function hostPicker(app: App) {
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
