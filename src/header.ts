// The window's own title bar. The OS one is off (decorations: false), so this bar is what you
// drag, and it is where the menus live — nothing should be reachable only by right-click.
import type { App } from "./app";
import { openMenu } from "./menu";
import { newProject } from "./rail";
import { toast } from "./ui";

export function installHeader(app: App) {
  const bar = document.querySelector<HTMLElement>("#titlebar")!;

  const menus: [string, () => { label: string; hint?: string; danger?: boolean; onPick: () => void }[]][] = [
    ["Shell", () => [
      ...app.config.profiles.map((p, i) => ({
        label: `New ${p.name} tab`,
        hint: `Ctrl+Shift+${i + 1}`,
        onPick: () => void app.newTab(p),
      })),
      ...app.config.hosts.map((h) => ({
        label: `SSH · ${h.name}`,
        hint: h.user ? `${h.user}@${h.host}` : h.host,
        onPick: () => void app.newTabForHost(h),
      })),
      { label: "Host book…", hint: "Ctrl+Shift+H", onPick: () => app.palette.open("ssh ") },
      { label: "Manage profiles…", onPick: () => void app.tp.openSettings("profiles") },
    ]],
    ["Panes", () => [
      { label: "Split right", hint: "Alt+Shift+=", onPick: () => void app.splitPane("row") },
      { label: "Split down", hint: "Alt+Shift+-", onPick: () => void app.splitPane("col") },
      { label: "One pane", onPick: () => void app.applyPreset("1") },
      { label: "Four panes", onPick: () => void app.applyPreset("4") },
      { label: "Find in scrollback", hint: "Ctrl+Shift+F", onPick: () => app.find.open() },
      { label: app.tab?.active.logPath ? "Stop capture" : "Start capture", hint: "Ctrl+Shift+L", onPick: () => void app.toggleLog() },
      { label: "Close pane", hint: "Ctrl+Shift+W", danger: true, onPick: () => app.tab && app.closePane(app.tab.active, app.tab) },
    ]],
    ["Project", () => [
      { label: "New project…", hint: "Ctrl+Shift+N", onPick: () => newProject(app) },
      ...app.config.projects.map((p) => ({
        label: `New tab in ${p.name}`,
        onPick: () => void app.newTab(undefined, p.id),
      })),
      { label: "Collapse all", onPick: () => {
        for (const p of app.config.projects) p.collapsed = true;
        app.paint();
        app.persistConfig();
      } },
      { label: "Manage projects…", onPick: () => void app.tp.openSettings("projects") },
    ]],
    ["View", () => [
      { label: app.config.rail_collapsed ? "Show the rail" : "Collapse the rail", hint: "Ctrl+Shift+B", onPick: () => app.toggleRail() },
      { label: "Zoom in", hint: "Ctrl +", onPick: () => app.zoom(1) },
      { label: "Zoom out", hint: "Ctrl −", onPick: () => app.zoom(-1) },
      { label: "Reset zoom", hint: "Ctrl 0", onPick: () => app.zoom(0) },
      { label: "Appearance…", onPick: () => void app.tp.openSettings("appearance") },
    ]],
  ];

  const group = bar.querySelector<HTMLElement>(".menus")!;
  group.replaceChildren(
    ...menus.map(([label, items]) => {
      const b = document.createElement("button");
      b.className = "hmenu";
      b.textContent = label;
      b.onclick = (e) => {
        e.stopPropagation();
        const box = b.getBoundingClientRect();
        openMenu(box.left, box.bottom + 4, items());
      };
      return b;
    }),
  );

  bar.querySelector<HTMLElement>(".search")!.onclick = () => app.palette.open();
  bar.querySelector<HTMLElement>(".gear")!.onclick = () =>
    void app.tp.openSettings().catch((e) => toast(`Settings did not open: ${e}`));

  for (const b of bar.querySelectorAll<HTMLButtonElement>(".win")) {
    b.onclick = () => void app.tp.windowAction("main", b.dataset.action as "minimize" | "maximize" | "close");
  }
}
