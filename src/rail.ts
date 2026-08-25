// The vertical rail: tabs grouped by project, each group in its own colour, each row carrying
// what its shell is doing. Rows are cached per tab and patched in place — a rebuild on every
// title and cwd report would throw away an open rename and churn thirty rows a second.
import { isDangerous } from "./agent";
import type { Activity, App, Tab } from "./app";
import { COLORS, openMenu } from "./menu";
import { editInline } from "./ui";
import * as L from "./layout";
import type { Project } from "./transport";

interface Row {
  li: HTMLLIElement;
  num: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  badge: HTMLElement;
  rec: HTMLElement;
  state: HTMLElement;
}

const rows = new WeakMap<Tab, Row>();
/** What the last render laid out, so structure work only happens when the structure changed. */
let lastShape = "";

export function renderRail(app: App) {
  const body = document.querySelector<HTMLElement>("#rail-body")!;
  const loose = app.tabs.filter((t) => !app.project(t.projectId));
  const groups: [Project | null, Tab[]][] = [];
  if (loose.length) groups.push([null, loose]);
  for (const project of app.config.projects) {
    groups.push([project, app.tabs.filter((t) => t.projectId === project.id)]);
  }

  const shape = groups
    .map(([p, tabs]) => `${p?.id ?? "-"}:${p?.name ?? ""}:${p?.color ?? ""}:${p?.collapsed ? 1 : 0}:${tabs.map((t) => t.id).join(",")}`)
    .join("|");
  if (shape !== lastShape) {
    lastShape = shape;
    body.replaceChildren(...groups.map(([project, tabs]) => group(app, project, tabs)));
  }

  for (const [project, tabs] of groups) {
    for (const tab of tabs) patchRow(app, tab);
    if (project) patchGroup(app, project, tabs);
  }
  patchHeader(app);
  patchAgents(app);
}

/** The pinned Agents row: hidden until a Claude session exists, loud only when one waits. */
function patchAgents(app: App) {
  const el = document.querySelector<HTMLElement>("#rail-agents")!;
  const c = app.agentCounts();
  el.hidden = c.total === 0;
  if (el.hidden) return;
  el.classList.toggle("alert", c.needsYou > 0);
  const badge = el.querySelector<HTMLElement>(".abadge")!;
  const n = c.needsYou || c.doneUnread;
  badge.hidden = n === 0;
  set(badge, n ? String(n) : "");
  badge.classList.toggle("quietly", !c.needsYou && c.doneUnread > 0);
  set(el.querySelector<HTMLElement>(".asub")!, c.needsYou ? (c.loudest ?? "") : "");
  set(el.querySelector<HTMLElement>(".awork")!, c.working ? `${c.working} working` : c.sleeping ? `${c.sleeping} sleeping` : "");
  el.onclick = () => app.deck.toggle();
}

function patchHeader(app: App) {
  const el = document.querySelector<HTMLElement>("#rail-waiting")!;
  const n = app.waiting();
  el.textContent = n ? `${n} waiting` : "";
  el.hidden = n === 0;
}

function group(app: App, project: Project | null, tabs: Tab[]): HTMLElement {
  const el = document.createElement("section");
  el.className = "group";
  if (project) {
    el.style.setProperty("--group", project.color);
    el.classList.toggle("collapsed", project.collapsed);
    el.dataset.project = project.id;
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML =
      `<button class="chev" title="Collapse or expand"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 3 11 8 6 13"/></svg></button>` +
      `<span class="dot"></span><span class="gname"></span><span class="gstates"></span><span class="gcount"></span>` +
      `<button class="gadd" title="New tab in this project">+</button>`;
    head.querySelector(".gname")!.textContent = project.name;
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
  for (const tab of tabs) list.appendChild(rowFor(app, tab).li);
  el.appendChild(list);
  return el;
}

/** A folded project must still be able to say that something inside it is waiting. */
function patchGroup(app: App, project: Project, tabs: Tab[]) {
  const head = document.querySelector<HTMLElement>(`.group[data-project="${project.id}"] .group-head`);
  if (!head) return;
  head.querySelector(".gcount")!.textContent = tabs.length ? String(tabs.length) : "";
  const states = [...new Set(tabs.map((t) => app.activity(t)))].filter((s) => s !== "idle");
  const holder = head.querySelector<HTMLElement>(".gstates")!;
  const wanted = states.join(",");
  if (holder.dataset.states === wanted) return;
  holder.dataset.states = wanted;
  holder.replaceChildren(
    ...states.map((s) => {
      const el = document.createElement("span");
      el.className = `st ${s} small`;
      return el;
    }),
  );
}

function rowFor(app: App, tab: Tab): Row {
  const cached = rows.get(tab);
  if (cached) return cached;

  const li = document.createElement("li");
  li.className = "tab";
  li.innerHTML =
    `<span class="num"></span>` +
    `<span class="label"><span class="title"></span><span class="sub"></span></span>` +
    `<span class="badge" hidden></span><span class="rec" hidden title="capturing to a log file">●</span>` +
    `<span class="st"></span>` +
    `<button class="close" title="Close this tab (Ctrl+Shift+Q)">×</button>`;
  const row: Row = {
    li,
    num: li.querySelector(".num")!,
    title: li.querySelector(".title")!,
    sub: li.querySelector(".sub")!,
    badge: li.querySelector(".badge")!,
    rec: li.querySelector(".rec")!,
    state: li.querySelector(".st")!,
  };
  li.onclick = () => app.activate(tab);
  li.ondblclick = () => renameTab(app, tab, li);
  li.onauxclick = (e) => e.button === 1 && app.closeTab(tab);
  li.oncontextmenu = (e) => {
    e.preventDefault();
    tabMenu(app, tab, e.clientX, e.clientY);
  };
  (li.querySelector(".close") as HTMLButtonElement).onclick = (e) => {
    e.stopPropagation();
    app.closeTab(tab);
  };
  rows.set(tab, row);
  return row;
}

function patchRow(app: App, tab: Tab) {
  const row = rowFor(app, tab);
  // Never patch a row the user is typing a name into.
  if (row.li.contains(document.activeElement) && document.activeElement?.classList.contains("inline-edit")) return;

  const panes = L.panes(tab.root);
  const title = app.title(tab);
  const state = app.activity(tab);
  const exited = panes.find((p) => p.exitCode && !p.eco);
  const agentPane = panes.find((p) => p.agent.state);
  const agentDetail = agentPane?.agent.detail ?? null;
  const eco = panes.some((p) => p.eco);
  // "Editing pty.rs · 12m" — how long this agent has been at it. Quiet for the first minute:
  // a fresh agent labelled "1m" reads as stuck when it is two seconds old.
  const workedMin = agentPane?.agent.state === "working" && agentPane.agent.workingSince
    ? Math.floor((Date.now() - agentPane.agent.workingSince) / 60_000)
    : 0;
  const working = workedMin >= 1 ? ` · ${workedMin}m` : "";
  const sub = exited
    ? `exited · code ${exited.exitCode}`
    : eco
      ? "agent sleeping — click to resume"
      : agentDetail
        ? agentDetail + working
        : (tab.active.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? tab.active.profile.name);

  row.li.classList.toggle("active", tab === app.tab);
  row.li.classList.toggle("dead", state === "exited");
  row.li.style.setProperty("--tab-accent", app.accent(tab));
  row.li.title = `${title}\n${tab.active.profile.name}${tab.active.cwd ? `\n${tab.active.cwd}` : ""}`;

  set(row.num, String(app.tabs.indexOf(tab) + 1));
  set(row.title, title);
  set(row.sub, sub === title ? "" : sub);
  row.badge.hidden = panes.length < 2;
  set(row.badge, panes.length > 1 ? String(panes.length) : "");
  row.rec.hidden = !panes.some((p) => p.logPath);
  // The motion language: one word per row, priority ordered, and stillness is a state too.
  const motion = panes.some((p) => p.agent.state === "blocked" && isDangerous(p.agent))
    ? "danger"
    : state === "bell"
      ? "ask"
      : panes.some((p) => p.agent.state === "working")
        ? "working"
        : "still";
  if (row.li.dataset.motion !== motion) row.li.dataset.motion = motion;
  // OSC 9;4 progress, parsed for a long time and finally drawn: a sliver along the row's foot.
  const progress = panes.map((p) => p.progress).find((v) => v !== null) ?? null;
  row.li.classList.toggle("has-prog", progress !== null);
  if (progress !== null) row.li.style.setProperty("--prog", `${progress}%`);
  if (row.state.dataset.state !== state) {
    row.state.dataset.state = state;
    row.state.className = `st ${state}`;
    row.state.title = STATE_TITLE[state];
  }
}

const STATE_TITLE: Record<Activity, string> = {
  running: "printing output right now",
  idle: "quiet — at a prompt",
  bell: "needs you — a permission prompt or a question",
  unread: "finished while you were elsewhere",
  exited: "the shell ended with a non-zero code",
};

function set(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export function renameTab(app: App, tab: Tab, row?: HTMLElement) {
  const host = (row ?? rows.get(tab)?.li)?.querySelector<HTMLElement>(".label");
  if (!host) return;
  editInline(host, app.title(tab), "Tab name", (v) => {
    app.renameTab(tab, v === app.title(tab) ? (tab.name ?? "") : v);
    // The label's children were replaced by the editor; rebuild this row from scratch.
    rows.delete(tab);
    lastShape = "";
    app.paint();
  });
}

function tabMenu(app: App, tab: Tab, x: number, y: number) {
  const capturing = tab.active.logPath;
  const blocked = L.panes(tab.root).find((p) => p.agent.state === "blocked" && p.agent.pendingId);
  openMenu(x, y, [
    ...(blocked
      ? [
          {
            label: `Allow: ${blocked.agent.detail ?? "the request"}`,
            onPick: () => void app.answerAgent(blocked, true),
          },
          { label: "Deny it", danger: true, onPick: () => void app.answerAgent(blocked, false) },
        ]
      : []),
    { label: "Rename tab", hint: "F2", onPick: () => renameTab(app, tab) },
    { label: "Split right", hint: "Alt+Shift+=", onPick: () => void app.splitPane("row") },
    { label: "Split down", hint: "Alt+Shift+-", onPick: () => void app.splitPane("col") },
    { label: capturing ? "Stop capture" : "Start capture", hint: "Ctrl+Shift+L", onPick: () => void app.toggleLog() },
    { label: "New tab in a worktree…", hint: "Ctrl+Shift+U", onPick: () => newWorktree(app) },
    { label: "Move to project…", onPick: () => moveMenu(app, tab, x, y) },
    { label: "Tab colour…", onPick: () => colorMenu(x, y, tab.color, (c) => app.setTabColor(tab, c)) },
    { label: "Settings…", hint: "Ctrl+Shift+,", onPick: () => app.settings.open() },
    { label: "Close pane", hint: "Ctrl+Shift+W", onPick: () => app.closePane(tab.active, tab) },
    { label: "Close tab", hint: "Ctrl+Shift+Q", danger: true, onPick: () => app.closeTab(tab) },
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
    {
      label: "Open saved layout",
      hint: `${((project.layout ?? []) as unknown[]).length} saved`,
      onPick: () => void app.openProjectLayout(project),
    },
    { label: "Close this project's tabs", onPick: () => app.closeProjectTabs(project) },
    {
      label: "Rename…",
      onPick: () =>
        editInline(nameEl, project.name, "Project name", (v) => {
          project.name = v;
          lastShape = "";
          app.paint();
          app.persistConfig();
        }),
    },
    {
      label: "Project colour…",
      onPick: () =>
        colorMenu(x, y, project.color, (c) => {
          project.color = c ?? COLORS[0]!.value;
          lastShape = "";
          app.paint();
          app.persistConfig();
        }),
    },
    { label: "Edit in settings…", onPick: () => app.settings.open("projects") },
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

/** Inline "name the worktree" field — same spot as the new-project prompt. */
export function newWorktree(app: App) {
  const host = document.querySelector<HTMLElement>("#rail-new")!;
  host.hidden = false;
  editInline(host, "", "Worktree name (becomes the branch)", (v) => {
    host.hidden = true;
    host.replaceChildren();
    if (v) void app.newWorktreeTab(v);
  });
}

/** Inline "new project" field at the foot of the rail — no modal, Escape cancels. */
export function newProject(app: App, then?: (p: ReturnType<App["addProject"]>) => void) {
  const host = document.querySelector<HTMLElement>("#rail-new")!;
  host.hidden = false;
  editInline(host, "", "Project name", (v) => {
    host.hidden = true;
    host.replaceChildren();
    lastShape = "";
    if (!v) return app.paint();
    const project = app.addProject(v);
    app.paint();
    then?.(project);
  });
}
