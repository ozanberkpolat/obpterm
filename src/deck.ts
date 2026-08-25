// The Agent Deck (Ctrl+G): one live card per Claude session across every tab — state, the
// last lines of its screen, and the held permission answerable right here. The rail's badge
// counts what this view shows; clicking a card jumps to its pane.
import type { App, Tab } from "./app";
import { isClaudePane, isDangerous } from "./agent";
import type { Pane } from "./pane";
import { toast } from "./ui";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

interface Card {
  el: HTMLElement;
  name: HTMLElement;
  chip: HTMLElement;
  tail: HTMLElement;
  ask: HTMLElement;
  foot: HTMLElement;
  actions: HTMLElement;
  /** The agents this session fanned out, rendered under its card. */
  fan: HTMLElement;
}

/** Loudest first: what the grid sorts by. */
const ORDER = ["blocked", "waiting", "working", "done", null] as const;

export class Deck {
  isOpen = false;
  private root = $("#deck");
  private grid = $("#deck .dgrid");
  private summary = $("#deck .dsummary");
  private cards = new Map<Pane, Card>();
  /** The panes behind the cards, in paint order — what the keyboard selection indexes. */
  private order: { pane: Pane; tab: Tab }[] = [];
  private sel = 0;
  /** RSS bytes per pane id, refreshed while open. */
  private rss = new Map<number, number>();
  private rssTimer = 0;
  /** What the header's filter box holds; matched against title, project and task text. */
  private filter = "";

  constructor(private app: App) {
    const box = $<HTMLInputElement>("#deck .dfilter input");
    box.addEventListener("input", () => {
      this.filter = box.value.trim().toLowerCase();
      this.sel = 0;
      this.paint();
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation(); // typing a filter must not fire the deck's own single-key verbs
      if (e.code === "Escape") {
        if (box.value) {
          box.value = "";
          this.filter = "";
          this.paint();
        }
        this.grid.focus();
      }
      if (e.code === "Enter" || e.code === "ArrowDown") this.grid.focus();
    });
    this.root.addEventListener("mousedown", (e) => e.target === this.root && this.close());
    $("#deck .dclose").addEventListener("click", () => this.close());
    this.grid.tabIndex = -1; // focusable, so keystrokes stop leaking to the pane behind
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent) {
    const move = (d: number) => {
      this.sel = Math.max(0, Math.min(this.order.length - 1, this.sel + d));
      this.paint();
      this.cards.get(this.order[this.sel]?.pane as Pane)?.el.scrollIntoView({ block: "nearest" });
    };
    const entry = this.order[this.sel];
    const danger = entry ? isDangerous(entry.pane.agent) : false;
    if (e.code === "ArrowDown" || e.code === "KeyJ") move(1);
    else if (e.code === "ArrowUp" || e.code === "KeyK") move(-1);
    else if (e.code === "KeyA" && entry?.pane.agent.pendingId) {
      // Muscle-memory `a` must not approve a red card; `y` is the deliberate key.
      if (danger) toast("That one is dangerous — press y to allow it, d to deny");
      else void this.app.answerAgent(entry.pane, true);
    } else if (e.code === "KeyY" && entry?.pane.agent.pendingId && danger) void this.app.answerAgent(entry.pane, true);
    else if (e.code === "KeyD" && entry?.pane.agent.pendingId) void this.app.answerAgent(entry.pane, false);
    else if (e.code === "KeyW" && entry?.pane.agent.pendingId) void this.alwaysAllow(entry.pane);
    else if (e.code === "KeyT" && entry && (entry.pane.agent.state === "blocked" || entry.pane.agent.state === "waiting")) {
      this.cards.get(entry.pane)?.el.querySelector<HTMLInputElement>(".dreply input")?.focus();
    } else if (e.code === "Enter" && entry) this.jump(entry.pane, entry.tab);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** `w`: persist "always allow this" into the project's own Claude settings, then allow. */
  private async alwaysAllow(pane: Pane) {
    const a = pane.agent;
    if (isDangerous(a)) return toast("Not making a standing rule out of a dangerous command");
    if (a.tool !== "Bash" || !a.toolInput) return toast("Always-allow only knows shell commands so far — Allow it normally");
    const word = a.toolInput.trim().split(/\s+/)[0];
    if (!word || !pane.cwd) return toast("No command word or working directory to pin the rule to");
    const rule = `Bash(${word}:*)`;
    try {
      await this.app.tp.allowRule(pane.cwd, rule);
      await this.app.answerAgent(pane, true);
      toast(`Allowed, and ${rule} is now always allowed in this project`);
    } catch (e) {
      toast(`Rule not saved: ${e}`);
    }
  }

  private jump(pane: Pane, tab: Tab) {
    this.close();
    this.app.activate(tab);
    this.app.focusPane(pane);
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.root.hidden = false;
    this.sel = 0;
    this.paint();
    this.grid.focus();
    void this.refreshTitles();
    void this.refreshRss();
    this.rssTimer = window.setInterval(() => {
      void this.refreshRss();
      void this.refreshTitles();
    }, 3000);
  }

  close() {
    this.isOpen = false;
    this.root.hidden = true;
    clearInterval(this.rssTimer);
    this.app.tab?.active.focus();
  }

  /** Claude names every conversation; the cards should use those names — plus the context
   *  fill and the diffstat, all from the same slow lane. */
  private async refreshTitles() {
    for (const { pane, tab } of this.order) {
      if (pane.cwd) {
        const stat = await this.app.tp.gitShortstat(pane.cwd).catch(() => null);
        pane.diffstat = shortstat(stat);
      }
      if (!pane.claudeSessionId) continue;
      const dir = this.app.account(tab.accountId)?.claude_dir ?? "~/.claude";
      const title = await this.app.tp.sessionTitle(dir, pane.claudeSessionId).catch(() => null);
      if (title && title !== pane.claudeTitle) pane.claudeTitle = title;
      pane.ctxPct = await this.app.tp.sessionContext(dir, pane.claudeSessionId).catch(() => null);
    }
    this.paint();
  }

  /** What each session's process tree weighs — the number Eco decisions need. */
  private async refreshRss() {
    if (!this.isOpen) return;
    const sessions = await this.app.tp.listSessions().catch(() => []);
    const pidOf = new Map(sessions.map((s) => [s.id, s.pid]));
    const entries = this.order.filter(({ pane }) => pane.id > 0 && pidOf.get(pane.id));
    if (!entries.length) return;
    const rss = await this.app.tp.rssFor(entries.map(({ pane }) => pidOf.get(pane.id)!)).catch(() => []);
    entries.forEach(({ pane }, i) => rss[i] !== undefined && this.rss.set(pane.id, rss[i]!));
    this.paint();
  }

  /** Every Claude pane, loudest first, with the tab it lives in. */
  panes(): { pane: Pane; tab: Tab }[] {
    const all = this.app.tabs.flatMap((tab) => this.app.panesOf(tab).map((pane) => ({ pane, tab })));
    const q = this.filter;
    const matches = ({ pane, tab }: { pane: Pane; tab: Tab }) => {
      if (!q) return true;
      const hay = [
        this.app.title(tab),
        pane.claudeTitle,
        this.app.project(tab.projectId)?.name,
        pane.cwd,
        pane.agent.detail,
        ...pane.agent.fanned.map((f) => `${f.kind} ${f.task}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };
    return all
      .filter(({ pane }) => isClaudePane(pane))
      .filter(matches)
      .sort((a, b) => {
        // A dangerous held request outranks everything — it is what the deck exists for.
        const danger = Number(b.pane.agent.state === "blocked" && isDangerous(b.pane.agent)) - Number(a.pane.agent.state === "blocked" && isDangerous(a.pane.agent));
        return danger || ORDER.indexOf(a.pane.agent.state) - ORDER.indexOf(b.pane.agent.state);
      });
  }

  paint() {
    if (!this.isOpen) return;
    const entries = this.panes();
    const counts = this.app.agentCounts();
    const all = this.app.tabs.flatMap((t) => this.app.panesOf(t)).filter(isClaudePane).length;
    set($("#deck .dcountall"), this.filter ? `${entries.length}/${all}` : String(all));
    this.summary.replaceChildren();
    const add = (text: string, cls = "") => {
      const s = document.createElement("span");
      if (cls) s.className = cls;
      s.textContent = text;
      this.summary.appendChild(s);
    };
    if (counts.needsYou) add(`${counts.needsYou} need${counts.needsYou > 1 ? "" : "s"} you`, "hot");
    add([counts.working && `${counts.working} working`, counts.done && `${counts.done} done`, counts.sleeping && `${counts.sleeping} sleeping`].filter(Boolean).join(" · ") || "");

    this.order = entries;
    this.sel = Math.min(this.sel, Math.max(0, entries.length - 1));
    const seen = new Set<Pane>();
    entries.forEach(({ pane, tab }, i) => {
      seen.add(pane);
      const card = this.patch(pane, tab);
      card.el.classList.toggle("selected", i === this.sel);
      this.grid.appendChild(card.el); // append re-orders in place
    });
    for (const [pane, card] of this.cards) {
      if (!seen.has(pane)) {
        card.el.remove();
        this.cards.delete(pane);
      }
    }
    this.grid.classList.toggle("empty", !entries.length);
    const empty = $("#deck .dempty");
    empty.hidden = entries.length > 0;
    set(empty, this.filter ? `Nothing matches “${this.filter}”.` : "No Claude sessions running. Open a tab with a claude profile and its state shows up here.");
  }

  private patch(pane: Pane, tab: Tab): Card {
    const card = this.cards.get(pane) ?? this.build(pane);
    const app = this.app;
    const a = pane.agent;
    const state = pane.eco ? "eco" : pane.asleep ? "asleep" : (a.state ?? "shell");
    card.el.dataset.state = state;
    card.el.classList.toggle("danger", a.state === "blocked" && isDangerous(a));
    card.el.style.setProperty("--card-accent", app.accent(tab));
    set(card.name, pane.claudeTitle ?? app.title(tab));
    const project = app.project(tab.projectId);
    const projEl = card.el.querySelector<HTMLElement>(".dproj")!;
    projEl.hidden = !project;
    if (project) {
      set(projEl, project.name);
      projEl.style.color = project.color;
      projEl.style.background = `color-mix(in srgb, ${project.color} 16%, transparent)`;
    }
    const live = a.fanned.filter((f) => f.endedAt === null).length;
    const countEl = card.el.querySelector<HTMLElement>(".dcount")!;
    countEl.hidden = a.fanned.length === 0;
    set(countEl, `×${a.fanned.length}`);
    countEl.classList.toggle("live", live > 0);
    const chip = CHIP[state] ?? state;
    const worked = state === "working" && a.workingSince ? Date.now() - a.workingSince : 0;
    set(card.chip, worked >= 60_000 ? `${chip} · ${dur(worked)}` : chip);
    const stateEl = card.el.querySelector<HTMLElement>(".dstate")!;
    set(stateEl, stateLine(pane));
    stateEl.dataset.state = state;
    set(card.tail, this.tail(pane));
    // A working agent that has printed nothing for a while is the one to look at.
    const quiet = state === "working" && pane.lastOutput && Date.now() - pane.lastOutput > 60_000
      ? `quiet ${dur(Date.now() - pane.lastOutput)}`
      : "";
    const prog = card.el.querySelector<HTMLElement>(".dprog")!;
    prog.hidden = pane.progress === null;
    if (pane.progress !== null) prog.querySelector<HTMLElement>("i")!.style.width = `${pane.progress}%`;
    const ctx = card.el.querySelector<HTMLElement>(".dctx")!;
    ctx.hidden = pane.ctxPct === null;
    if (pane.ctxPct !== null) {
      ctx.querySelector<HTMLElement>(".bar i")!.style.width = `${pane.ctxPct}%`;
      set(ctx.querySelector<HTMLElement>(".v")!, `${pane.ctxPct}%`);
      ctx.classList.toggle("high", pane.ctxPct >= 70 && pane.ctxPct < 85);
      ctx.classList.toggle("full", pane.ctxPct >= 85);
    }
    // The held question, in the agent's words, with its options when it asked one.
    const ask = a.state === "blocked" || a.state === "waiting" ? (a.detail ?? "") : "";
    set(card.ask.querySelector<HTMLElement>(".q")!, ask);
    const options = ask && a.options.length ? a.options : [];
    const opts = card.ask.querySelector<HTMLElement>(".opts")!;
    if (opts.dataset.options !== options.join("|")) {
      opts.dataset.options = options.join("|");
      opts.replaceChildren(
        ...options.map((o) => {
          const li = document.createElement("li");
          li.textContent = o;
          return li;
        }),
      );
    }
    card.ask.hidden = !ask;
    card.actions.hidden = !(a.state === "blocked" && a.pendingId);
    card.el.querySelector<HTMLElement>(".dreply")!.hidden = !(a.state === "blocked" || a.state === "waiting");
    const mb = this.rss.get(pane.id);
    set(card.foot, [
      pane.profile.name,
      pane.cwd?.split(/[\\/]/).filter(Boolean).pop(),
      quiet,
      mb ? `${Math.round(mb / 1048576)} MB` : null,
      pane.diffstat,
    ].filter(Boolean).join(" · "));
    this.paintFan(card, pane);
    return card;
  }

  /** The agents a session fanned out: one row each, entering once as they are spawned. */
  private paintFan(card: Card, pane: Pane) {
    const agents = pane.agent.fanned;
    card.fan.hidden = agents.length === 0;
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      let row = card.fan.querySelector<HTMLElement>(`[data-agent="${CSS.escape(a.id)}"]`);
      if (!row) {
        row = document.createElement("div");
        row.className = "dagent enter"; // enter plays exactly once, on the spawn
        row.dataset.agent = a.id;
        row.innerHTML = `<span class="adot"></span><span class="akind"></span><span class="atask"></span><span class="afeed"></span>`;
        card.fan.appendChild(row);
        window.setTimeout(() => row?.classList.remove("enter"), 500);
      }
      const live = a.endedAt === null;
      row.classList.toggle("live", live);
      set(row.querySelector<HTMLElement>(".akind")!, a.kind.toUpperCase().slice(0, 14));
      set(row.querySelector<HTMLElement>(".atask")!, a.task || a.feed || "working");
      const secs = Math.round(((a.endedAt ?? Date.now()) - a.startedAt) / 1000);
      set(
        row.querySelector<HTMLElement>(".afeed")!,
        [a.feed && a.task ? a.feed : null, secs >= 1 ? `${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`}` : null, a.tools ? `${a.tools} tools` : null]
          .filter(Boolean)
          .join(" · "),
      );
    }
    for (const row of [...card.fan.children]) {
      if (!seen.has((row as HTMLElement).dataset.agent!)) row.remove();
    }
  }

  private build(pane: Pane): Card {
    const el = document.createElement("article");
    el.className = "dcard";
    el.innerHTML =
      `<header><span class="ddot"></span><span class="dname"></span><span class="dproj" hidden></span><span class="dcount" hidden></span><span class="dchip"></span></header>` +
      `<div class="dstate"></div>` +
      `<pre class="dtail"></pre>` +
      `<div class="dprog" hidden><i></i></div>` +
      `<div class="dctx" hidden title="How full this session's context window is — at 100% it auto-compacts and loses detail"><span class="k">ctx</span><span class="bar"><i></i></span><span class="v"></span></div>` +
      `<div class="dask" hidden><div class="q"></div><ul class="opts"></ul></div>` +
      `<div class="dactions" hidden><button class="allow">Allow</button><button class="deny">Deny</button><button class="always" title="Allow, and never ask for this command in this project again">Always</button></div>` +
      `<div class="dreply" hidden><input type="text" placeholder="type an answer — Enter sends it to the session" spellcheck="false"></div>` +
      `<footer class="dfoot"></footer>` +
      `<div class="dfan" hidden></div>`;
    el.addEventListener("click", () => {
      const tab = this.app.tabs.find((t) => this.app.panesOf(t).includes(pane));
      if (tab) this.jump(pane, tab);
    });
    const stopThen = (fn: () => void) => (e: Event) => {
      e.stopPropagation();
      fn();
    };
    el.querySelector<HTMLButtonElement>(".allow")!.onclick = stopThen(() => {
      if (isDangerous(pane.agent)) toast("That one is dangerous — press y (or this card's Deny)");
      else void this.app.answerAgent(pane, true);
    });
    el.querySelector<HTMLButtonElement>(".deny")!.onclick = stopThen(() => void this.app.answerAgent(pane, false));
    el.querySelector<HTMLButtonElement>(".always")!.onclick = stopThen(() => void this.alwaysAllow(pane));
    const reply = el.querySelector<HTMLInputElement>(".dreply input")!;
    reply.addEventListener("click", (e) => e.stopPropagation());
    reply.addEventListener("keydown", (e) => {
      e.stopPropagation(); // the deck's own keys (and the app's) must not fire while typing
      if (e.code === "Escape") {
        reply.value = "";
        this.grid.focus();
      } else if (e.code === "Enter" && reply.value.trim()) {
        // The answer lands in the pty as if typed in the pane; the settle timer will flip the
        // state once the session reacts.
        void this.app.tp.write(pane.id, reply.value + "\r").catch(() => {});
        pane.agent.state = "working";
        pane.agent.workingSince = Date.now();
        pane.agent.pendingId = null;
        reply.value = "";
        this.grid.focus();
        this.app.paint();
      }
    });
    const card: Card = {
      el,
      name: el.querySelector(".dname")!,
      chip: el.querySelector(".dchip")!,
      tail: el.querySelector(".dtail")!,
      ask: el.querySelector(".dask")!,
      foot: el.querySelector(".dfoot")!,
      actions: el.querySelector(".dactions")!,
      fan: el.querySelector(".dfan")!,
    };
    this.cards.set(pane, card);
    return card;
  }

  /** The last lines of the pane's screen. A sleeping pane has no terminal to read. */
  private tail(pane: Pane, rows = 9): string {
    if (pane.eco) return "sleeping to save memory — click to resume the conversation";
    if (pane.asleep) {
      const h = pane.heldState;
      return h && Date.now() - h.last_output < 5000
        ? "asleep — the shell is still printing; click to watch"
        : "asleep — click to wake";
    }
    if (pane.exited) return `exited${pane.exitCode ? ` with code ${pane.exitCode}` : ""}`;
    const buf = pane.term.term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.length - 1; i >= 0 && lines.length < rows; i--) {
      const line = buf.getLine(i)?.translateToString(true).trimEnd() ?? "";
      if (lines.length || line) lines.unshift(line);
    }
    return lines.join("\n");
  }
}

const CHIP: Record<string, string> = {
  blocked: "needs you",
  waiting: "needs you",
  working: "working",
  done: "done",
  eco: "sleeping",
  asleep: "asleep",
  shell: "shell",
};

/** The one line under the title: what this session is doing, in words. */
function stateLine(pane: Pane): string {
  const a = pane.agent;
  if (pane.eco) return "sleeping to save memory — click to resume";
  if (pane.asleep) return "asleep — click to wake";
  if (pane.exited) return `exited${pane.exitCode ? ` with code ${pane.exitCode}` : ""}`;
  if (a.state === "blocked") return `${a.detail ?? "asking"} · a allow · d deny · w always`;
  if (a.state === "waiting") return `${a.detail ?? "waiting on you"} · t reply`;
  if (a.state === "done") return `✓ ${a.detail ?? "done"}`;
  if (a.state === "working") return a.detail ?? "working";
  return pane.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? pane.profile.name;
}

/** "3 files changed, 412 insertions(+), 87 deletions(-)" -> "+412 −87"; "" -> "±0". */
function shortstat(raw: string | null): string | null {
  if (raw === null) return null;
  if (!raw) return "±0";
  const ins = /(\d+) insertion/.exec(raw)?.[1] ?? "0";
  const del = /(\d+) deletion/.exec(raw)?.[1] ?? "0";
  return `+${ins} −${del}`;
}

/** 90000 -> "1m", 3720000 -> "1h 2m". Coarse on purpose — it repaints once a second. */
function dur(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function set(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
