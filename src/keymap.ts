// The rebindable shortcuts: one registry of actions with default chords, resolved against
// config.keybindings into one chord→action map that keys.ts consults on every keydown and
// ownsKey() uses to keep those chords away from the shell. Structural keys — Ctrl+digits,
// Alt+arrows, the zoom row, Escape, F12 — stay fixed; a chord is `Mods+e.code`.
import type { App } from "./app";
import type { Config } from "./transport";
import { newProject, newWorktree, renameTab } from "./rail";
import { hostPicker, profilePicker } from "./keys";

export interface KeyAction {
  id: string;
  label: string;
  /** Default chord, e.g. "Ctrl+Shift+KeyT" or "F2". */
  def: string;
  run: (app: App) => void;
}

export const ACTIONS: KeyAction[] = [
  { id: "new-tab", label: "New tab", def: "Ctrl+Shift+KeyT", run: (a) => void a.newTab() },
  { id: "profiles", label: "Pick a profile for a new tab", def: "Ctrl+Shift+KeyP", run: (a) => profilePicker(a) },
  { id: "palette", label: "Command palette", def: "Ctrl+KeyK", run: (a) => a.palette.open() },
  { id: "agents", label: "Agent deck", def: "Ctrl+KeyG", run: (a) => a.deck.toggle() },
  { id: "needs-you", label: "Go to the agent that needs you", def: "Ctrl+Shift+KeyG", run: (a) => a.jumpNeedsYou() },
  { id: "dup-tab", label: "Duplicate tab (same directory)", def: "Ctrl+Shift+KeyD", run: (a) => void a.duplicateTab() },
  { id: "review", label: "Review changes (git diff in a split)", def: "Ctrl+Shift+KeyY", run: (a) => void a.reviewSplit() },
  { id: "worktree", label: "New tab in a worktree", def: "Ctrl+Shift+KeyU", run: (a) => newWorktree(a) },
  { id: "rename", label: "Rename the tab", def: "F2", run: (a) => { if (a.tab) renameTab(a, a.tab); } },
  { id: "close", label: "Close pane, or the tab when it is the last", def: "Ctrl+Shift+KeyW", run: (a) => { if (a.tab) a.closePane(a.tab.active, a.tab); } },
  { id: "close-tab", label: "Close the whole tab", def: "Ctrl+Shift+KeyQ", run: (a) => { if (a.tab) a.closeTab(a.tab); } },
  { id: "recent", label: "Back to the tab you were just in", def: "Ctrl+Tab", run: (a) => a.recent() },
  { id: "cycle", label: "Previous tab in the rail", def: "Ctrl+Shift+Tab", run: (a) => a.cycle(-1) },
  { id: "split-right", label: "Split right", def: "Alt+Shift+Equal", run: (a) => void a.splitPane("row") },
  { id: "split-down", label: "Split down", def: "Alt+Shift+Minus", run: (a) => void a.splitPane("col") },
  { id: "find", label: "Find in scrollback", def: "Ctrl+Shift+KeyF", run: (a) => a.find.open() },
  { id: "capture", label: "Start / stop capturing this pane", def: "Ctrl+Shift+KeyL", run: (a) => void a.toggleLog() },
  { id: "hosts", label: "SSH host book", def: "Ctrl+Shift+KeyH", run: (a) => hostPicker(a) },
  { id: "projects", label: "New project", def: "Ctrl+Shift+KeyN", run: (a) => newProject(a) },
  { id: "rail", label: "Collapse the rail", def: "Ctrl+Shift+KeyB", run: (a) => a.toggleRail() },
  { id: "copy", label: "Copy the selection", def: "Ctrl+Shift+KeyC", run: (a) => void a.copy() },
  { id: "paste", label: "Paste", def: "Ctrl+Shift+KeyV", run: (a) => void a.paste() },
  { id: "settings", label: "Settings", def: "Ctrl+Shift+Comma", run: (a) => a.settings.open() },
];

/** What the Keyboard section lists but nothing can rebind. */
export const FIXED: { label: string; keys: string }[] = [
  { label: "Jump to tab 1…9", keys: "Ctrl 1…9" },
  { label: "New tab with profile 1…9", keys: "Ctrl Shift 1…9" },
  { label: "Move this tab up / down the rail", keys: "Ctrl Shift ↑ ↓" },
  { label: "Move focus between panes", keys: "Alt ← ↑ → ↓" },
  { label: "Resize the focused pane", keys: "Alt Shift ← ↑ → ↓" },
  { label: "Font size", keys: "Ctrl + − 0 · Ctrl wheel" },
];

/** "Ctrl+Shift+KeyT" for the event, "" for a bare modifier press. */
export function chordOf(e: KeyboardEvent): string {
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code)) return "";
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.code);
  return parts.join("+");
}

/** "Ctrl+Shift+KeyT" → "Ctrl Shift T", for the chips in Settings. */
export function pretty(chord: string): string {
  return chord
    .split("+")
    .map((p) => p.replace(/^Key/, "").replace(/^Digit/, "").replace("Comma", ",").replace("Equal", "=").replace("Minus", "−"))
    .join(" ");
}

/** The chord an action currently answers to. */
export function chordFor(config: Config, action: KeyAction): string {
  return config.keybindings[action.id] || action.def;
}

let map = new Map<string, KeyAction>();

/** Rebuilds the chord→action map. Call at boot and whenever keybindings change. */
export function bindKeys(config: Config) {
  map = new Map();
  for (const action of ACTIONS) map.set(chordFor(config, action), action);
}

export function actionFor(e: KeyboardEvent): KeyAction | null {
  return map.get(chordOf(e)) ?? null;
}
