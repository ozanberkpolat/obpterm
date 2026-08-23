// One list of shortcuts, so the Keyboard section shows what keys.ts actually does.
export interface Binding {
  id: string;
  label: string;
  keys: string[];
}

export const KEYMAP: Binding[] = [
  { id: "new-tab", label: "New tab", keys: ["Ctrl", "Shift", "T"] },
  { id: "profiles", label: "Pick a profile", keys: ["Ctrl", "Shift", "P"] },
  { id: "palette", label: "Command palette", keys: ["Ctrl", "K"] },
  { id: "rename", label: "Rename the tab", keys: ["F2"] },
  { id: "close", label: "Close pane, or the tab when it is the last", keys: ["Ctrl", "Shift", "W"] },
  { id: "cycle", label: "Next / previous tab", keys: ["Ctrl", "Tab"] },
  { id: "jump", label: "Jump to tab 1…9", keys: ["Ctrl", "1…9"] },
  { id: "profile-n", label: "New tab with profile 1…9", keys: ["Ctrl", "Shift", "1…9"] },
  { id: "split-right", label: "Split right", keys: ["Alt", "Shift", "="] },
  { id: "split-down", label: "Split down", keys: ["Alt", "Shift", "-"] },
  { id: "focus", label: "Move focus between panes", keys: ["Alt", "← ↑ → ↓"] },
  { id: "resize", label: "Resize the focused pane", keys: ["Alt", "Shift", "← ↑ → ↓"] },
  { id: "find", label: "Find in scrollback", keys: ["Ctrl", "Shift", "F"] },
  { id: "capture", label: "Start / stop capturing this pane", keys: ["Ctrl", "Shift", "L"] },
  { id: "hosts", label: "SSH host book", keys: ["Ctrl", "Shift", "H"] },
  { id: "projects", label: "New project", keys: ["Ctrl", "Shift", "N"] },
  { id: "rail", label: "Collapse the rail", keys: ["Ctrl", "Shift", "B"] },
  { id: "copy", label: "Copy / paste", keys: ["Ctrl", "Shift", "C / V"] },
  { id: "zoom", label: "Font size", keys: ["Ctrl", "+ − 0"] },
  { id: "settings", label: "Settings", keys: ["Ctrl", "Shift", ","] },
];
