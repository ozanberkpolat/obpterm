// The pane toolbar, lifted from iot-stack's /ssh/ terminal: copy, paste, send Ctrl+C, clear,
// then a layout picker that snaps the tab to 1 / 2 / 2 / 4 panes.
import type { App } from "./app";

export type Preset = "1" | "2c" | "2r" | "4";

const ICONS: Record<string, string> = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  ctrlc: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  clear: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
};

const LAYOUTS: { id: Preset; title: string; svg: string }[] = [
  { id: "1", title: "One pane", svg: '<rect x="1.5" y="1.5" width="13" height="13" rx="2"/>' },
  { id: "2c", title: "Two panes side by side", svg: '<rect x="1.5" y="1.5" width="13" height="13" rx="2"/><line x1="8" y1="1.5" x2="8" y2="14.5"/>' },
  { id: "2r", title: "Two panes stacked", svg: '<rect x="1.5" y="1.5" width="13" height="13" rx="2"/><line x1="1.5" y1="8" x2="14.5" y2="8"/>' },
  { id: "4", title: "Four panes", svg: '<rect x="1.5" y="1.5" width="13" height="13" rx="2"/><line x1="8" y1="1.5" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/>' },
];

export function installToolbar(app: App) {
  const bar = document.querySelector<HTMLElement>("#toolbar")!;
  const icon = (paths: string, stroke = 2) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  const actions: [string, string, string, () => void][] = [
    ["copy", "Copy selection (Ctrl+Shift+C)", ICONS.copy!, () => void app.copy()],
    ["paste", "Paste (Ctrl+Shift+V)", ICONS.paste!, () => void app.paste()],
    ["ctrlc", "Send Ctrl+C", ICONS.ctrlc!, () => app.sendKey("\x03")],
    ["clear", "Clear this pane", ICONS.clear!, () => app.clearPane()],
  ];

  bar.replaceChildren();
  for (const [id, title, paths, onClick] of actions) {
    const b = document.createElement("button");
    b.className = "tb" + (id === "ctrlc" ? " danger" : "");
    b.title = title;
    b.innerHTML = icon(paths, id === "ctrlc" ? 2.4 : 2);
    b.onclick = onClick;
    bar.appendChild(b);
  }

  const picker = document.createElement("div");
  picker.className = "layout-picker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Pane layout");
  for (const l of LAYOUTS) {
    const b = document.createElement("button");
    b.className = "tb";
    b.dataset.layout = l.id;
    b.title = l.title;
    b.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">${l.svg}</svg>`;
    b.onclick = () => void app.applyPreset(l.id);
    picker.appendChild(b);
  }
  bar.appendChild(picker);
  return { paint: () => paintPicker(app, picker) };
}

/** Marks the preset that matches what is on screen, so the picker reads as state, not just buttons. */
function paintPicker(app: App, picker: HTMLElement) {
  const current = app.tab ? app.currentPreset(app.tab) : null;
  for (const b of picker.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("on", b.dataset.layout === current);
  }
}
