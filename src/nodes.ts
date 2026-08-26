// Node View: the same agent registry the panel shows, laid out spatially. Sessions are nodes,
// the agents they fanned out hang beneath them on computed edges, plain shells sit in their own
// band, and a forked session keeps a dashed line to where it came from. Nothing is dragged —
// the layout is derived from the fleet, so a node is born where its parent is.
import type { App, Tab } from "./app";
import { asksPermission, hasLiveDescendant, isClaudePane, isDangerous, modeLabel, type FannedAgent } from "./agent";
import type { Pane } from "./pane";
import { toast } from "./ui";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** What a node is: everything on the map, not only agents. */
export type NodeKind = "session" | "agent" | "shell" | "origin";

interface Node {
  id: string;
  kind: NodeKind;
  /** The pane behind it, for session and shell nodes. */
  pane?: Pane;
  tab?: Tab;
  agent?: FannedAgent;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

// The spine: sessions stack down the left, their agents branch to the right. Nothing ever
// moves sideways, so ten sessions scroll instead of forcing a pan.
const SESSION_W = 330;
const SESSION_H = 172;
const AGENT_W = 250;
const AGENT_H = 104;
/** Left edge of the agent column, measured from the spine. */
const BRANCH_X = 500;
/** One column per generation: an agent that delegated sits left of what it delegated to. */
const DEPTH_X = AGENT_W + 110;
/** Vertical air between agents of one session, and between sessions. */
const AGENT_GAP = 20;
const SESSION_GAP = 46;

/** Loudest first, so the eye lands on what waits. */
const ORDER = ["blocked", "waiting", "working", "done", null] as const;

export class Nodes {
  private root = $("#nodemap");
  private world = $("#nodemap .nworld");
  private edges = $<SVGSVGElement & HTMLElement>("#nodemap .nedges");
  private els = new Map<string, HTMLElement>();
  private nodes: Node[] = [];
  private sel = 0;
  /** Pan/zoom of the world, applied as one transform. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  constructor(private app: App) {
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.installDrag();
    $("#nodemap .nfit").addEventListener("click", () => this.fit());
    $("#nodemap .nclose").addEventListener("click", () => this.close());
    $("#nodemap .nzoom-in").addEventListener("click", () => this.setZoom(this.zoom * 1.2));
    $("#nodemap .nzoom-out").addEventListener("click", () => this.setZoom(this.zoom / 1.2));
  }

  /** Sessions, their agents, plain shells and origins — the whole workspace. */
  private collect(): Node[] {
    const out: Node[] = [];
    const sessions: Node[] = [];
    for (const tab of this.app.tabs) {
      for (const pane of this.app.panesOf(tab)) {
        const id = `p${pane.id}`;
        // The map is what is RUNNING. A session earns a node by working, by waiting on you,
        // or by having a live agent out; idle, finished, sleeping and exited ones stay in the
        // rail, where they belong. Plain shells only make it while they are printing.
        const dormant = pane.asleep || pane.eco || pane.exited;
        const a = pane.agent;
        const liveAgents = a.fanned.some((f) => f.endedAt === null);
        const busy = a.state === "working" || a.state === "blocked" || a.state === "waiting" || liveAgents;
        if (isClaudePane(pane)) {
          if (!dormant && busy) sessions.push({ id, kind: "session", pane, tab, parent: null, x: 0, y: 0, w: SESSION_W, h: SESSION_H });
        }
        // Plain shells are not what this view is for; they live in the rail.
      }
    }
    sessions.sort((a, b) => {
      const danger = Number(b.pane!.agent.state === "blocked" && isDangerous(b.pane!.agent)) - Number(a.pane!.agent.state === "blocked" && isDangerous(a.pane!.agent));
      return danger || ORDER.indexOf(a.pane!.agent.state) - ORDER.indexOf(b.pane!.agent.state);
    });

    // One band per session: the session on the spine, its agents stacked in the branch column
    // beside it, the band as tall as whichever side is taller.
    let y = 0;
    for (const s of sessions) {
      // The map is what is happening: an agent that has finished is gone from it.
      // What is running, plus the agents those are hanging from: a parent that launched
      // background sub-agents is already finished, and without it the branch has no trunk.
      const fan = s.pane!.agent.fanned;
      const agents = fan.filter((a) => a.endedAt === null || hasLiveDescendant(s.pane!.agent, a.id));
      // Agents delegate too, so the branch is a tree, not a column. An agent whose parent has
      // already finished (and been pruned) hangs off the session rather than off nothing.
      const live = new Set(agents.map((a) => a.id));
      const childrenOf = (id: string | null) =>
        agents.filter((a) => (a.parent && live.has(a.parent) ? a.parent : null) === id);
      const placed: Node[] = [];
      /** Lays a subtree out top-down and returns the height it claimed. */
      const place = (a: (typeof agents)[number], depth: number, top: number): number => {
        const kids = childrenOf(a.id);
        let cursor = top;
        let kidsH = 0;
        for (const kid of kids) {
          const h = place(kid, depth + 1, cursor);
          cursor += h + AGENT_GAP;
          kidsH += h + AGENT_GAP;
        }
        kidsH = Math.max(0, kidsH - AGENT_GAP);
        const height = Math.max(AGENT_H, kidsH);
        const parentId = a.parent && live.has(a.parent) ? `${s.id}:${a.parent}` : s.id;
        placed.push({
          id: `${s.id}:${a.id}`,
          kind: "agent",
          agent: a,
          pane: s.pane,
          tab: s.tab,
          parent: parentId,
          x: BRANCH_X + depth * DEPTH_X,
          y: top + (height - AGENT_H) / 2,
          w: AGENT_W,
          h: AGENT_H,
        });
        return height;
      };
      let fanH = 0;
      for (const root of childrenOf(null)) {
        fanH += place(root, 0, fanH) + AGENT_GAP;
      }
      fanH = Math.max(0, fanH - AGENT_GAP);
      const bandH = Math.max(s.h, fanH);
      s.x = 0;
      s.y = y + (bandH - s.h) / 2;
      out.push(s);
      // The subtree was laid out from 0; drop it into the band, centred against the session.
      const offset = y + (bandH - fanH) / 2;
      for (const n of placed) {
        n.y += offset;
        out.push(n);
      }
      // A restored fork keeps a dashed thread back to where it came from — to its left.
      if (s.pane!.claudeSessionId && s.tab?.name && s.pane!.profile.args.includes("--resume")) {
        out.push({ id: `${s.id}:origin`, kind: "origin", parent: s.id, tab: s.tab, x: -300, y: s.y + 40, w: 240, h: 62 });
      }
      y += bandH + SESSION_GAP;
    }

    return out;
  }

  paint() {
    if (this.root.hidden) return;
    this.nodes = this.collect();
    this.sel = Math.min(this.sel, Math.max(0, this.nodes.length - 1));
    const seen = new Set<string>();
    for (const [i, n] of this.nodes.entries()) {
      seen.add(n.id);
      const el = this.ensure(n);
      el.classList.toggle("sel", i === this.sel);
      el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      el.style.width = `${n.w}px`;
      this.fill(el, n);
    }
    for (const [id, el] of this.els) {
      if (!seen.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    this.drawEdges();
    const none = $("#nodemap .nnone");
    none.hidden = this.nodes.length > 0;
    // Say what the map is deliberately not showing, so nothing feels lost.
    const shown = new Set(this.nodes.filter((n) => n.pane).map((n) => n.pane!.id));
    const quiet = this.app.tabs.flatMap((t) => this.app.panesOf(t)).filter((p) => !shown.has(p.id) && !p.exited).length;
    set($("#nodemap .nsummary"), [summary(this.app), quiet ? `${quiet} idle` : null].filter(Boolean).join(" · "));
    const diag = $("#nodemap .ndiag");
    diag.hidden = !!this.app.lastFanEventAt;
    if (!this.app.lastFanEventAt) set(diag, this.app.agentsDiagnosis());
  }

  /** Creates a node's element once; its entrance animation therefore plays exactly once. */
  private ensure(n: Node): HTMLElement {
    let el = this.els.get(n.id);
    if (el) return el;
    el = document.createElement("article");
    el.className = `nnode ${n.kind} born`;
    el.dataset.id = n.id;
    el.innerHTML =
      `<header><span class="ndot"></span><span class="nname"></span><span class="nmode" hidden></span><span class="nproj" hidden></span><span class="npill"></span></header>` +
      `<div class="nbody"></div>` +
      `<footer class="nfoot"></footer>` +
      `<div class="nact" hidden><button class="allow">Allow</button><button class="deny">Deny</button><button class="always" title="Allow, and never ask for this command in this project again">Always</button></div>` +
      `<div class="nreply" hidden><input type="text" placeholder="type an answer — Enter sends it" spellcheck="false"></div>`;
    // A node is born where its parent is: the entrance starts from the edge's anchor.
    const parent = this.nodes.find((p) => p.id === n.parent);
    if (parent) {
      el.style.setProperty("--from-x", `${parent.x + parent.w / 2 - n.x - n.w / 2}px`);
      el.style.setProperty("--from-y", `${parent.y + parent.h - n.y}px`);
    }
    window.setTimeout(() => el?.classList.remove("born"), 520);
    el.addEventListener("click", () => this.activate(n));
    el.querySelector<HTMLButtonElement>(".allow")!.onclick = (e) => {
      e.stopPropagation();
      if (n.pane && isDangerous(n.pane.agent)) toast("That one is dangerous — press y to allow it");
      else if (n.pane) void this.app.answerAgent(n.pane, true);
    };
    el.querySelector<HTMLButtonElement>(".deny")!.onclick = (e) => {
      e.stopPropagation();
      if (n.pane) void this.app.answerAgent(n.pane, false);
    };
    el.querySelector<HTMLButtonElement>(".always")!.onclick = (e) => {
      e.stopPropagation();
      if (n.pane) void this.alwaysAllow(n.pane);
    };
    const reply = el.querySelector<HTMLInputElement>(".nreply input")!;
    reply.addEventListener("click", (e) => e.stopPropagation());
    reply.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Escape") {
        reply.value = "";
        this.root.focus();
      } else if (e.code === "Enter" && reply.value.trim() && n.pane) {
        void this.app.tp.write(n.pane.id, reply.value + "\r").catch(() => {});
        n.pane.agent.state = "working";
        n.pane.agent.workingSince = Date.now();
        n.pane.agent.pendingId = null;
        reply.value = "";
        this.root.focus();
        this.app.paint();
      }
    });
    this.world.appendChild(el);
    this.els.set(n.id, el);
    return el;
  }

  private fill(el: HTMLElement, n: Node) {
    const pill = el.querySelector<HTMLElement>(".npill")!;
    const name = el.querySelector<HTMLElement>(".nname")!;
    const body = el.querySelector<HTMLElement>(".nbody")!;
    const foot = el.querySelector<HTMLElement>(".nfoot")!;
    const act = el.querySelector<HTMLElement>(".nact")!;

    if (n.kind === "agent") {
      const a = n.agent!;
      const live = a.endedAt === null;
      // A finished agent only survives on the map while it is the trunk something else is
      // still hanging from. Say so, rather than showing it as work in progress.
      const trunk = !live && this.nodes.some((x) => x.parent === n.id);
      el.classList.toggle("trunk", trunk);
      el.dataset.state = live ? "working" : "done";
      set(name, a.kind.toUpperCase().slice(0, 16));
      set(pill, live ? "running" : trunk ? "delegated" : "done");
      set(body, a.task || a.feed || "working");
      const secs = Math.round(((a.endedAt ?? Date.now()) - a.startedAt) / 1000);
      set(foot, [a.feed && a.task ? a.feed : null, secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`, a.tools ? `${a.tools} tools` : null].filter(Boolean).join(" · "));
      act.hidden = true;
      return;
    }
    if (n.kind === "origin") {
      el.dataset.state = "origin";
      set(name, "ORIGIN");
      set(pill, "");
      set(body, `resumed · ${n.tab?.name ?? ""}`);
      set(foot, "");
      act.hidden = true;
      return;
    }

    const pane = n.pane!;
    const a = pane.agent;
    const state = pane.eco ? "eco" : pane.asleep ? "asleep" : (a.state ?? (n.kind === "shell" ? "shell" : "idle"));
    el.dataset.state = state;
    set(name, pane.claudeTitle ?? this.app.title(n.tab!));
    set(pill, PILL[state] ?? state);
    const project = this.app.project(n.tab!.projectId);
    const proj = el.querySelector<HTMLElement>(".nproj")!;
    proj.hidden = !project;
    if (project) {
      set(proj, project.name);
      proj.style.color = project.color;
      proj.style.background = `color-mix(in srgb, ${project.color} 16%, transparent)`;
    }
    set(body, tailOf(pane, n.kind === "session" ? 5 : 3));
    const live = a.fanned.filter((f) => f.endedAt === null).length;
    set(
      foot,
      [
        a.workingSince && a.state === "working" ? mins(Date.now() - a.workingSince) : null,
        pane.ctxPct !== null ? `ctx ${pane.ctxPct}%` : null,
        pane.diffstat,
        live ? `${live} live` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    // In auto mode nothing ever asks; the buttons would be decoration.
    act.hidden = !(a.state === "blocked" && a.pendingId && asksPermission(a));
    el.querySelector<HTMLElement>(".nreply")!.hidden = !(a.state === "blocked" || a.state === "waiting");
    const mode = el.querySelector<HTMLElement>(".nmode")!;
    const label = modeLabel(a);
    mode.hidden = !label;
    set(mode, label);
    el.classList.toggle("danger", a.state === "blocked" && isDangerous(a));
  }

  /** Edges are computed from real geometry: parent's bottom-centre to child's top-centre. */
  private drawEdges() {
    if (!this.nodes.length) return void (this.edges.innerHTML = "");
    const paths: string[] = [];
    for (const n of this.nodes) {
      if (!n.parent) continue;
      const p = this.nodes.find((x) => x.id === n.parent);
      if (!p) continue;
      const isOrigin = n.kind === "origin";
      // Sideways now: out of the session's right edge, into the agent's left. An origin sits
      // to the LEFT of its session, so its anchors mirror.
      const x1 = isOrigin ? p.x : p.x + p.w;
      const y1 = p.y + p.h / 2;
      const x2 = isOrigin ? n.x + n.w : n.x;
      const y2 = n.y + n.h / 2;
      const dx = (x2 - x1) / 2;
      const stroke = isOrigin ? "rgba(180,140,255,.35)" : n.agent?.endedAt === null ? "rgba(255,138,30,.5)" : "rgba(140,160,190,.3)";
      const dash = isOrigin ? ' stroke-dasharray="4 4"' : "";
      paths.push(
        `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" stroke="${stroke}" stroke-width="1.5" fill="none"${dash}/>` +
          `<circle cx="${x1}" cy="${y1}" r="3" fill="${stroke}"/><circle cx="${x2}" cy="${y2}" r="3" fill="${stroke}"/>`,
      );
    }
    this.edges.innerHTML = paths.join("");
    // The SVG is 0×0 with `overflow: visible`, which is enough for the paths to LAY OUT in the
    // right place — getBoundingClientRect agrees — and not enough for them to be painted. Give
    // it a viewport that actually covers the nodes, in the same world coordinates the paths use.
    const pad = 60;
    const minX = Math.min(...this.nodes.map((n) => n.x)) - pad;
    const minY = Math.min(...this.nodes.map((n) => n.y)) - pad;
    const maxX = Math.max(...this.nodes.map((n) => n.x + n.w)) + pad;
    const maxY = Math.max(...this.nodes.map((n) => n.y + n.h)) + pad;
    const box = this.edges.style;
    box.left = `${minX}px`;
    box.top = `${minY}px`;
    box.width = `${maxX - minX}px`;
    box.height = `${maxY - minY}px`;
    this.edges.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  }

  // ---- view -------------------------------------------------------------------------------

  private apply() {
    this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    set($("#nodemap .nlevel"), `${Math.round(this.zoom * 100)}%`);
  }

  private setZoom(z: number) {
    this.zoom = Math.min(2, Math.max(0.3, z));
    this.apply();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) return this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    this.panX -= e.deltaX;
    this.panY -= e.deltaY;
    this.apply();
  }

  private installDrag() {
    let from: { x: number; y: number; px: number; py: number } | null = null;
    this.root.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".nnode, button")) return; // dragging the ground only
      from = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      this.root.setPointerCapture(e.pointerId);
      this.root.classList.add("panning");
    });
    this.root.addEventListener("pointermove", (e) => {
      if (!from) return;
      this.panX = from.px + (e.clientX - from.x);
      this.panY = from.py + (e.clientY - from.y);
      this.apply();
    });
    const end = () => {
      from = null;
      this.root.classList.remove("panning");
    };
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);
  }

  /** Frames everything — the only layout command, since nothing is placed by hand. */
  fit() {
    if (!this.nodes.length) return;
    const minX = Math.min(...this.nodes.map((n) => n.x));
    const maxX = Math.max(...this.nodes.map((n) => n.x + n.w));
    const minY = Math.min(...this.nodes.map((n) => n.y));
    const maxY = Math.max(...this.nodes.map((n) => n.y + n.h));
    const box = this.root.getBoundingClientRect();
    const pad = 90;
    this.zoom = Math.min(1.1, Math.max(0.3, Math.min((box.width - pad * 2) / (maxX - minX || 1), (box.height - pad * 2) / (maxY - minY || 1))));
    this.panX = box.width / 2 - ((minX + maxX) / 2) * this.zoom;
    this.panY = box.height / 2 - ((minY + maxY) / 2) * this.zoom;
    this.apply();
  }

  private onKey(e: KeyboardEvent) {
    const move = (d: number) => {
      this.sel = Math.max(0, Math.min(this.nodes.length - 1, this.sel + d));
      this.paint();
    };
    const n = this.nodes[this.sel];
    const pane = n?.pane;
    const danger = pane ? isDangerous(pane.agent) : false;
    const asks = pane ? asksPermission(pane.agent) : true;
    if (e.code === "ArrowDown" || e.code === "KeyJ") move(1);
    else if (e.code === "ArrowUp" || e.code === "KeyK") move(-1);
    else if (e.code === "ArrowRight") {
      // Into this session's first agent, if it has one out.
      const first = this.nodes.findIndex((x) => x.parent === n?.id && x.kind === "agent");
      if (first >= 0) {
        this.sel = first;
        this.paint();
      }
    } else if (e.code === "ArrowLeft" && n?.parent) {
      const back = this.nodes.findIndex((x) => x.id === n.parent);
      if (back >= 0) {
        this.sel = back;
        this.paint();
      }
    }
    else if (e.code === "KeyA" && pane?.agent.pendingId && asks) {
      if (danger) toast("That one is dangerous — press y to allow it, d to deny");
      else void this.app.answerAgent(pane, true);
    } else if (e.code === "KeyY" && pane?.agent.pendingId && danger) void this.app.answerAgent(pane, true);
    else if (e.code === "KeyD" && pane?.agent.pendingId && asks) void this.app.answerAgent(pane, false);
    else if (e.code === "KeyW" && pane?.agent.pendingId && asks) void this.alwaysAllow(pane);
    else if (e.code === "KeyT" && pane && (pane.agent.state === "blocked" || pane.agent.state === "waiting")) {
      this.els.get(n!.id)?.querySelector<HTMLInputElement>(".nreply input")?.focus();
    } else if (e.code === "KeyF") this.fit();
    else if (e.code === "Enter" && n) this.activate(n);
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

  /** Clicking a node goes to the real thing: its tab and pane, terminal and all. */
  private activate(n: Node) {
    if (!n.pane || !n.tab) return;
    this.app.showView("sessions");
    this.app.activate(n.tab);
    this.app.focusPane(n.pane);
  }

  // ---- open/close -------------------------------------------------------------------------

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    this.root.hidden = false;
    this.paint();
    this.fit();
    this.root.focus();
  }

  close() {
    this.root.hidden = true;
    // The rail's tabs read this: closing the map without clearing it left "Agents" lit while
    // the sessions were on screen.
    if (this.app.config.agents_view !== "sessions") {
      this.app.config.agents_view = "sessions";
      this.app.persistConfig();
    }
    this.app.paint();
    this.app.tab?.active.focus();
  }
}

const PILL: Record<string, string> = {
  blocked: "needs you",
  waiting: "needs you",
  working: "running",
  done: "done",
  eco: "sleeping",
  asleep: "asleep",
  shell: "shell",
  idle: "idle",
};

function mins(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.floor(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function summary(app: App): string {
  const c = app.agentCounts();
  return [c.needsYou ? `${c.needsYou} need you` : null, `${c.working} working`, c.done ? `${c.done} done` : null]
    .filter(Boolean)
    .join(" · ");
}

/** The last lines of a pane's screen — the node's living body. */
function tailOf(pane: Pane, rows: number): string {
  if (pane.eco) return "sleeping to save memory — click to resume";
  if (pane.asleep) return "asleep — click to wake";
  if (pane.exited) return `exited${pane.exitCode ? ` with code ${pane.exitCode}` : ""}`;
  const buf = pane.term.term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= 0 && lines.length < rows; i--) {
    const line = buf.getLine(i)?.translateToString(true).trimEnd() ?? "";
    if (lines.length || line) lines.unshift(line);
  }
  return lines.join("\n");
}

function set(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
