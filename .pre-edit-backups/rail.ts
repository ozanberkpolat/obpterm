// The vertical rail: tabs grouped by project, each group in its own colour, each row carrying
// what its shell is doing. Rows are cached per tab and patched in place — a rebuild on every
// title and cwd report would throw away an open rename and churn thirty rows a second.
import { isDangerous, modeLabel } from "./agent";
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
  /** "1.4G" — what this session's process tree is holding, once that is a lot. */
  rss: HTMLElement;
  /** "$1.24" — what this session has spent, once it is worth mentioning. */
  cost: HTMLElement;
  /** "ctx 88%", only once the conversation is close to full. */
  ctx: HTMLElement;
  badge: HTMLElement;
  rec: HTMLElement;
  state: HTMLElement;
}

const rows = new WeakMap<Tab, Row>();

/** 95000 -> "1m", 24000000 -> "6h40m". */
function fmtAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ""}`;
}

/** 412000 -> "412k", 2400000 -> "2.4M". */
function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
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

/** The rail's own tabs: Sessions and Agents. The badge rides the Agents tab, and the line
 *  under them names whatever is waiting on you. */
function patchAgents(app: App) {
  const bar = document.querySelector<HTMLElement>("#rail-views")!;
  const c = app.agentCounts();
  const view = app.config.agents_view;
  for (const b of bar.querySelectorAll<HTMLElement>(".rv")) {
    b.classList.toggle("on", b.dataset.view === view);
    if (!b.dataset.wired) {
      b.dataset.wired = "1";
      b.onclick = () => app.showView(b.dataset.view as "sessions" | "agents");
    }
  }
  const badge = bar.querySelector<HTMLElement>(".rvbadge")!;
  const n = c.needsYou || c.doneUnread;
  badge.hidden = n === 0;
  set(badge, n ? String(n) : "");
  badge.classList.toggle("quietly", !c.needsYou && c.doneUnread > 0);
  bar.classList.toggle("alert", c.needsYou > 0);

  const line = document.querySelector<HTMLElement>("#rail-agentline")!;
  const text = c.needsYou ? (c.loudest ?? "") : c.working ? `${c.working} working` : "";
  line.hidden = !text;
  set(line, text);
  line.classList.toggle("hot", c.needsYou > 0);
}

function patchHeader(app: App) {
  const el = document.querySelector<HTMLElement>("#rail-waiting")!;
  const n = app.waiting();
  const agents = app.liveAgentCount();
  const dead = app.exitedTabs().length;
  // Three facts, in the order they demand action. Each one is a button: the count that tells
  // you something is wrong and cannot be clicked is a count you have to act on by hand.
  const parts = [n ? `${n} waiting` : "", agents ? `${agents} agents` : "", dead ? `${dead} exited` : ""].filter(Boolean);
  el.textContent = parts.join(" · ");
  el.hidden = parts.length === 0;
  el.title = "Click: jump to the next session that needs you. Right-click: close every exited tab.";
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    el.style.cursor = "pointer";
    el.onclick = () => app.jumpNeedsYou();
    el.oncontextmenu = (e) => {
      e.preventDefault();
      app.closeExited();
    };
  }
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
    `<span class="rss" hidden></span>` +
    `<span class="cost" hidden></span>` +
    `<span class="ctx" hidden></span>` +
    `<span class="badge" hidden></span><span class="rec" hidden title="capturing to a log file">●</span>` +
    `<span class="st"></span>` +
    `<button class="close" title="Close this tab (Ctrl+Shift+Q)">×</button>`;
  const row: Row = {
    li,
    num: li.querySelector(".num")!,
    title: li.querySelector(".title")!,
    sub: li.querySelector(".sub")!,
    rss: li.querySelector(".rss")!,
    cost: li.querySelector(".cost")!,
    ctx: li.querySelector(".ctx")!,
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

/** The agents a session fanned out, as small pills directly under its row. They appear as
 *  they are spawned and leave when they finish — the rail says what is happening now. */
function patchAgentPills(tab: Tab, row: Row) {
  const agents = L.panes(tab.root).flatMap((p) => p.agent.fanned);
  let holder = row.li.nextElementSibling as HTMLElement | null;
  if (!holder?.classList.contains("agent-pills")) holder = null;
  if (!agents.length) {
    holder?.remove();
    return;
  }
  if (!holder) {
    holder = document.createElement("li");
    holder.className = "agent-pills";
    row.li.after(holder);
  }
  const seen = new Set<string>();
  for (const a of agents) {
    seen.add(a.id);
    let pill = holder.querySelector<HTMLElement>(`[data-agent="${CSS.escape(a.id)}"]`);
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "agent-pill enter";
      pill.dataset.agent = a.id;
      pill.innerHTML = `<i></i><b></b>`;
      holder.appendChild(pill);
      window.setTimeout(() => pill?.classList.remove("enter"), 420);
    }
    pill.classList.toggle("live", a.endedAt === null);
    // An agent that was spawned BY an agent is marked, so the rail does not read as a flat
    // fan-out when it is two deep. The map is where the shape is; this is the hint.
    pill.classList.toggle("nested", !!a.parent && agents.some((p) => p.id === a.parent));
    const secs = Math.round(((a.endedAt ?? Date.now()) - a.startedAt) / 1000);
    set(pill.querySelector<HTMLElement>("b")!, a.task || a.feed || a.kind);
    pill.title = `${a.kind} · ${a.task || a.feed || "working"} · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`}${a.tools ? ` · ${a.tools} tools` : ""}`;
  }
  for (const pill of [...holder.children]) {
    if (!seen.has((pill as HTMLElement).dataset.agent!)) pill.remove();
  }
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
  const mode = agentPane ? modeLabel(agentPane.agent) : "";
  // A session that stopped reporting mid-task is not the same as one sitting at a prompt, and
  // for twenty minutes it drew identically. Say which it is.
  const stalled = panes.find((p) => p.agent.stalledSince && !p.eco && !p.exited);
  const stalledMin = stalled?.agent.stalledSince ? Math.floor((Date.now() - stalled.agent.stalledSince) / 60_000) : 0;
  const sub = exited
    ? `exited · code ${exited.exitCode}`
    : stalled
      ? `stalled — nothing reported for ${stalledMin}m`
      : eco
        ? "agent sleeping — click to resume"
        : agentDetail
          ? agentDetail + working + (mode ? ` · ${mode}` : "")
          : (tab.active.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? tab.active.profile.name);

  row.li.classList.toggle("active", tab === app.tab);
  row.li.classList.toggle("dead", state === "exited");
  row.li.classList.toggle("stalled", !!stalled);
  row.li.style.setProperty("--tab-accent", app.accent(tab));
  // Everything the row knows and has no room to draw. Cheap: it is one string per patch.
  const a = tab.active.agent;
  const tools = Object.entries(a.toolCounts ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
  const fan = a.fanStats;
  const extra = [
    tab.active.startedAt ? `open ${fmtAge(Date.now() - tab.active.startedAt)}` : "",
    tools.length ? tools.map(([t, n]) => `${n} ${t}`).join(", ") : "",
    fan?.count ? `${fan.count} agents finished · longest ${fmtAge(fan.longestMs)}` : "",
    tab.active.usage?.turns ? `${tab.active.usage.turns} turns · $${(tab.active.usage.cost_usd / tab.active.usage.turns).toFixed(3)}/turn` : "",
  ].filter(Boolean);
  row.li.title = [title, tab.active.profile.name, tab.active.cwd ?? "", ...extra].filter(Boolean).join("\n");

  set(row.num, String(app.tabs.indexOf(tab) + 1));
  set(row.title, title);
  set(row.sub, sub === title ? "" : sub);
  // Context pressure. Only when it matters: a session at 40% is not news, one at 88% is about to
  // start forgetting the beginning of its own task.
  const warn = app.config.context_warn_pct;
  const full = warn ? panes.map((p) => p.ctxPct).filter((v): v is number => v !== null && v >= warn).sort((a, b) => b - a)[0] ?? null : null;
  row.ctx.hidden = full === null;
  if (full !== null) {
    set(row.ctx, `ctx ${full}%`);
    row.ctx.classList.toggle("hot", full >= 95);
    row.ctx.title = "This conversation is nearly full — right-click the tab to /compact it";
  }
  // What it is holding. Only the ones big enough to be worth exiting say so out loud; the
  // tooltip carries the number regardless, and the eco sweep sorts on it whether or not it
  // is drawn.
  const rss = panes.reduce((n, p) => n + p.rss, 0);
  row.rss.hidden = rss < 400e6;
  if (rss) {
    set(row.rss, rss >= 1e9 ? `${(rss / 1e9).toFixed(1)}G` : `${Math.round(rss / 1e6)}M`);
    row.rss.title = `${Math.round(rss / 1e6)} MB resident — this session's whole process tree`;
    row.rss.classList.toggle("heavy", rss >= 1.5e9);
  }
  // What it has cost. Below a dime it is noise; the tooltip carries the tokens either way.
  const cost = app.tabCost(tab);
  const tokens = panes.reduce((n, p) => n + (p.usage ? p.usage.input + p.usage.output + p.usage.cache_read + p.usage.cache_write : 0), 0);
  row.cost.hidden = cost === null || cost < 0.1;
  if (cost !== null) {
    set(row.cost, `$${cost < 10 ? cost.toFixed(2) : Math.round(cost)}`);
    const turns = panes.reduce((n, p) => n + (p.usage?.turns ?? 0), 0);
    row.cost.title = `${fmtTokens(tokens)} tokens${turns ? ` · ${turns} turns · $${(cost / turns).toFixed(3)} a turn` : ""} · estimated from this machine's transcripts, at the prices in Settings`;
  }
  row.badge.hidden = panes.length < 2;
  set(row.badge, panes.length > 1 ? String(panes.length) : "");
  row.rec.hidden = !panes.some((p) => p.logPath);
  patchAgentPills(tab, row);
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
    { label: "Reload session", hint: "restarts it on the same conversation", onPick: () => void app.reloadPane(tab.active) },
    { label: "Rename tab", hint: "F2", onPick: () => renameTab(app, tab) },
    { label: "Split right", hint: "Alt+Shift+=", onPick: () => void app.splitPane("row") },
    { label: "Split down", hint: "Alt+Shift+-", onPick: () => void app.splitPane("col") },
    { label: capturing ? "Stop capture" : "Start capture", hint: "Ctrl+Shift+L", onPick: () => void app.toggleLog() },
    { label: "Compact this conversation (/compact)", onPick: () => app.compact(tab.active) },
    {
      label: "Sleep this session",
      hint: "frees its memory; click to resume",
      onPick: () => void app.sleepTab(tab),
    },
    { label: "Move up", hint: "Ctrl+Shift+↑", onPick: () => app.moveTab(tab, -1) },
    { label: "Move down", hint: "Ctrl+Shift+↓", onPick: () => app.moveTab(tab, 1) },
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
    { label: "Move up", hint: "with its tabs", onPick: () => app.moveProject(project, -1) },
    { label: "Move down", hint: "with its tabs", onPick: () => app.moveProject(project, 1) },
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
  // Comma-separated makes the parallel case one keystroke sequence instead of N — parallel
  // worktrees are why the feature exists.
  editInline(host, "", "Worktree name, or several separated by commas", (v) => {
    host.hidden = true;
    host.replaceChildren();
    for (const name of v.split(",").map((n) => n.trim()).filter(Boolean)) void app.newWorktreeTab(name);
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
