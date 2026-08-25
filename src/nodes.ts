// Node View: the same agent registry the panel shows, laid out spatially. Sessions are nodes,
// the agents they fanned out hang beneath them on computed edges, plain shells sit in their own
// band, and a forked session keeps a dashed line to where it came from. Nothing is dragged —
// the layout is derived from the fleet, so a node is born where its parent is.
import type { App, Tab } from "./app";
import { isClaudePane, isDangerous, type FannedAgent } from "./agent";
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

const SESSION_W = 330;
const SESSION_H = 172;
const AGENT_W = 250;
const AGENT_H = 104;
const SHELL_W = 250;
const SHELL_H = 96;
const GAP_X = 40;
const ROW_Y = 250;

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
    $("#nodemap .nlist").addEventListener("click", () => this.app.toggleAgentsView());
    $("#nodemap .nzoom-in").addEventListener("click", () => this.setZoom(this.zoom * 1.2));
    $("#nodemap .nzoom-out").addEventListener("click", () => this.setZoom(this.zoom / 1.2));
  }

  /** Sessions, their agents, plain shells and origins — the whole workspace. */
  private collect(): Node[] {
    const out: Node[] = [];
    const sessions: Node[] = [];
    const shells: Node[] = [];
    for (const tab of this.app.tabs) {
      for (const pane of this.app.panesOf(tab)) {
        const id = `p${pane.id}`;
        if (isClaudePane(pane)) {
          sessions.push({ id, kind: "session", pane, tab, parent: null, x: 0, y: 0, w: SESSION_W, h: SESSION_H });
        } else {
          shells.push({ id, kind: "shell", pane, tab, parent: null, x: 0, y: 0, w: SHELL_W, h: SHELL_H });
        }
      }
    }
    sessions.sort((a, b) => {
      const danger = Number(b.pane!.agent.state === "blocked" && isDangerous(b.pane!.agent)) - Number(a.pane!.agent.state === "blocked" && isDangerous(a.pane!.agent));
      return danger || ORDER.indexOf(a.pane!.agent.state) - ORDER.indexOf(b.pane!.agent.state);
    });

    // Row 1: sessions. Row 2: each session's agents, centred under their parent.
    let x = 0;
    for (const s of sessions) {
      const agents = s.pane!.agent.fanned;
      const fanW = agents.length ? agents.length * AGENT_W + (agents.length - 1) * 16 : 0;
      const slotW = Math.max(s.w, fanW);
      s.x = x + (slotW - s.w) / 2;
      s.y = 0;
      out.push(s);
      let ax = x + (slotW - fanW) / 2;
      for (const a of agents) {
        out.push({ id: `${s.id}:${a.id}`, kind: "agent", agent: a, pane: s.pane, tab: s.tab, parent: s.id, x: ax, y: ROW_Y, w: AGENT_W, h: AGENT_H });
        ax += AGENT_W + 16;
      }
      // A restored fork keeps a dashed thread back to where it came from.
      if (s.pane!.claudeSessionId && s.tab?.name && s.pane!.profile.args.includes("--resume")) {
        out.push({ id: `${s.id}:origin`, kind: "origin", parent: s.id, tab: s.tab, x: s.x + 40, y: -140, w: 240, h: 62 });
      }
      x += slotW + GAP_X;
    }

    // Row 3: plain shells, so the map is the whole workspace and not only agents.
    let sx = 0;
    for (const sh of shells) {
      sh.x = sx;
      sh.y = ROW_Y * 2;
      sx += SHELL_W + 16;
      out.push(sh);
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
    set($("#nodemap .nsummary"), summary(this.app));
  }

  /** Creates a node's element once; its entrance animation therefore plays exactly once. */
  private ensure(n: Node): HTMLElement {
    let el = this.els.get(n.id);
    if (el) return el;
    el = document.createElement("article");
    el.className = `nnode ${n.kind} born`;
    el.dataset.id = n.id;
    el.innerHTML =
      `<header><span class="ndot"></span><span class="nname"></span><span class="nproj" hidden></span><span class="npill"></span></header>` +
      `<div class="nbody"></div>` +
      `<footer class="nfoot"></footer>` +
      `<div class="nact" hidden><button class="allow">Allow</button><button class="deny">Deny</button></div>`;
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
      el.dataset.state = live ? "working" : "done";
      set(name, a.kind.toUpperCase().slice(0, 16));
      set(pill, live ? "running" : "done");
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
    act.hidden = !(a.state === "blocked" && a.pendingId);
    el.classList.toggle("danger", a.state === "blocked" && isDangerous(a));
  }

  /** Edges are computed from real geometry: parent's bottom-centre to child's top-centre. */
  private drawEdges() {
    const paths: string[] = [];
    for (const n of this.nodes) {
      if (!n.parent) continue;
      const p = this.nodes.find((x) => x.id === n.parent);
      if (!p) continue;
      const isOrigin = n.kind === "origin";
      // Origin hangs above its session, so the anchors flip.
      const x1 = p.x + p.w / 2;
      const y1 = isOrigin ? p.y : p.y + p.h;
      const x2 = n.x + n.w / 2;
      const y2 = isOrigin ? n.y + n.h : n.y;
      const dy = (y2 - y1) / 2;
      const stroke = isOrigin ? "rgba(180,140,255,.35)" : n.agent?.endedAt === null ? "rgba(255,138,30,.5)" : "rgba(140,160,190,.3)";
      const dash = isOrigin ? ' stroke-dasharray="4 4"' : "";
      paths.push(
        `<path d="M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}" stroke="${stroke}" stroke-width="1.5" fill="none"${dash}/>` +
          `<circle cx="${x1}" cy="${y1}" r="3" fill="${stroke}"/><circle cx="${x2}" cy="${y2}" r="3" fill="${stroke}"/>`,
      );
    }
    this.edges.innerHTML = paths.join("");
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
    if (e.code === "ArrowRight" || e.code === "KeyJ") move(1);
    else if (e.code === "ArrowLeft" || e.code === "KeyK") move(-1);
    else if (e.code === "KeyA" && pane?.agent.pendingId) {
      if (danger) toast("That one is dangerous — press y to allow it, d to deny");
      else void this.app.answerAgent(pane, true);
    } else if (e.code === "KeyY" && pane?.agent.pendingId && danger) void this.app.answerAgent(pane, true);
    else if (e.code === "KeyD" && pane?.agent.pendingId) void this.app.answerAgent(pane, false);
    else if (e.code === "KeyF") this.fit();
    else if (e.code === "Enter" && n) this.activate(n);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Clicking a node goes to the real thing: its tab and pane, terminal and all. */
  private activate(n: Node) {
    if (!n.pane || !n.tab) return;
    this.close();
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
