// The vertical rail: tabs grouped by project, each group in its own colour.
import type { App, Tab } from "./app";
import { COLORS, openMenu } from "./menu";
import { editInline } from "./ui";
import * as L from "./layout";
import type { Project } from "./transport";

export function renderRail(app: App) {
  const body = document.querySelector<HTMLElement>("#rail-body")!;
  body.replaceChildren();
  const loose = app.tabs.filter((t) => !app.project(t.projectId));
  if (loose.length) body.appendChild(group(app, null, loose));
  for (const project of app.config.projects) {
    body.appendChild(group(app, project, app.tabs.filter((t) => t.projectId === project.id)));
  }
}

function group(app: App, project: Project | null, tabs: Tab[]): HTMLElement {
  const el = document.createElement("section");
  el.className = "group";
  if (project) {
    el.style.setProperty("--group", project.color);
    el.classList.toggle("collapsed", project.collapsed);
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML =
      `<button class="chev" title="Collapse or expand"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 3 11 8 6 13"/></svg></button>` +
      `<span class="dot"></span><span class="gname"></span><span class="gcount"></span>` +
      `<button class="gadd" title="New tab in this project">+</button>`;
    head.querySelector(".gname")!.textContent = project.name;
    head.querySelector(".gcount")!.textContent = tabs.length ? String(tabs.length) : "";
    // Clicking the row folds the group; the + is how you add a tab to it.
    head.onclick = () => app.toggleProject(project);
    head.oncontextmenu = (e) => {
      e.preventDefault();
      projectMenu(app, project, e.clientX, e.clientY, head.querySelector<HTMLElement>(".gname")!);
    };
    (head.querySelector(".gadd") as HTMLButtonElement).onclick = (e) => {
      e.stopPropagation();
      void app.newTab(undefined, project.id);
    };
    el.appendChild(head);
  }
  const list = document.createElement("ul");
  list.className = "glist";
  tabs.forEach((tab) => list.appendChild(row(app, tab)));
  el.appendChild(list);
  return el;
}

function row(app: App, tab: Tab): HTMLLIElement {
  const li = document.createElement("li");
  const index = app.tabs.indexOf(tab);
  const paneCount = L.panes(tab.root).length;
  const logging = L.panes(tab.root).some((p) => p.logPath);
  li.className = "tab" + (tab === app.tab ? " active" : "");
  li.style.setProperty("--tab-accent", app.accent(tab));
  li.title = `${app.title(tab)}\n${tab.active.profile.name}${tab.active.cwd ? `\n${tab.active.cwd}` : ""}`;
  li.innerHTML =
    `<span class="num">${index + 1}</span>` +
    `<span class="label"><span class="title"></span><span class="sub"></span></span>` +
    (paneCount > 1 ? `<span class="badge" title="${paneCount} panes">${paneCount}</span>` : "") +
    (logging ? `<span class="rec" title="capturing to a log file">●</span>` : "") +
    `<button class="close" title="Close (Ctrl+Shift+W)">×</button>`;
  li.querySelector(".title")!.textContent = app.title(tab);
  const sub = tab.active.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? tab.active.profile.name;
  li.querySelector(".sub")!.textContent = sub === app.title(tab) ? "" : sub;
  li.onclick = () => app.activate(tab);
  li.onauxclick = (e) => e.button === 1 && app.closeTab(tab);
  li.oncontextmenu = (e) => {
    e.preventDefault();
    tabMenu(app, tab, e.clientX, e.clientY);
  };
  (li.querySelector(".close") as HTMLButtonElement).onclick = (e) => {
    e.stopPropagation();
    app.closeTab(tab);
  };
  return li;
}

function tabMenu(app: App, tab: Tab, x: number, y: number) {
  const capturing = tab.active.logPath;
  openMenu(x, y, [
    { label: "Split right", hint: "Alt+Shift+=", onPick: () => void app.splitPane("row") },
    { label: "Split down", hint: "Alt+Shift+-", onPick: () => void app.splitPane("col") },
    { label: "Settings…", hint: "Ctrl+Shift+,", onPick: () => void app.tp.openSettings() },
    { label: capturing ? "Stop capture" : "Start capture", hint: "Ctrl+Shift+L", onPick: () => void app.toggleLog() },
    { label: "Move to project…", onPick: () => moveMenu(app, tab, x, y) },
    { label: "Tab colour…", onPick: () => colorMenu(x, y, tab.color, (c) => app.setTabColor(tab, c)) },
    { label: "Close tab", hint: "Ctrl+Shift+W", danger: true, onPick: () => app.closeTab(tab) },
  ]);
}

function moveMenu(app: App, tab: Tab, x: number, y: number) {
  openMenu(x, y, [
    { label: "No project", swatch: "#8b97a8", onPick: () => app.moveTabToProject(tab, null) },
    ...app.config.projects.map((p) => ({
      label: p.name,
      swatch: p.color,
      onPick: () => app.moveTabToProject(tab, p.id),
    })),
    { label: "New project…", onPick: () => newProject(app, (p) => app.moveTabToProject(tab, p.id)) },
  ]);
}

function projectMenu(app: App, project: Project, x: number, y: number, nameEl: HTMLElement) {
  openMenu(x, y, [
    { label: "New tab here", onPick: () => void app.newTab(undefined, project.id) },
    { label: "Save layout", hint: `${app.tabs.filter((t) => t.projectId === project.id).length} tabs`, onPick: () => app.saveProjectLayout(project) },
    { label: "Open saved layout", onPick: () => void app.openProjectLayout(project) },
    {
      label: "Rename…",
      onPick: () =>
        editInline(nameEl, project.name, "Project name", (v) => {
          project.name = v;
          app.paint();
          app.persist();
        }),
    },
    {
      label: "Project colour…",
      onPick: () =>
        colorMenu(x, y, project.color, (c) => {
          project.color = c ?? COLORS[0]!.value;
          app.paint();
          app.persist();
        }),
    },
    { label: "Edit in settings…", onPick: () => void app.tp.openSettings("projects") },
    { label: "Delete project", danger: true, onPick: () => app.deleteProject(project) },
  ]);
}

function colorMenu(x: number, y: number, current: string | null, set: (c: string | null) => void) {
  openMenu(x, y, [
    { label: "Default", swatch: "#8b97a8", onPick: () => set(null) },
    ...COLORS.map((c) => ({
      label: c.name + (c.value === current ? " ✓" : ""),
      swatch: c.value,
      onPick: () => set(c.value),
    })),
  ]);
}

/** Inline "new project" field at the foot of the rail — no modal, Escape cancels. */
export function newProject(app: App, then?: (p: ReturnType<App["addProject"]>) => void) {
  const host = document.querySelector<HTMLElement>("#rail-new")!;
  host.hidden = false;
  editInline(host, "", "Project name", (v) => {
    host.hidden = true;
    host.replaceChildren();
    if (!v) return app.paint();
    const project = app.addProject(v);
    app.paint();
    then?.(project);
  });
}
