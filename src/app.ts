// Tabs, panes and projects. A tab owns a pane tree; a project groups tabs, gives them a colour
// and can save/restore its own set of tabs.
import { isClaudePane, isDangerous, pruneFan, tick as agentTick } from "./agent";
import { withDefaults, type Account, type Config, type Host, type Profile, type Project, type Transport } from "./transport";
import { ACTIVE_MS, Pane, type PaneHost } from "./pane";
import * as L from "./layout";
import { applyTermConfig } from "./term";
import { renderRail } from "./rail";
import { bindKeys } from "./keymap";
import { toast } from "./ui";
import { COLORS } from "./menu";
import type { Find } from "./find";
import type { Status } from "./status";
import type { Preset } from "./toolbar";

/** Loudest first: this order is what a tab with several panes reports. */
export type Activity = "bell" | "exited" | "unread" | "running" | "idle";
const LOUDNESS: Activity[] = ["bell", "exited", "unread", "running", "idle"];

export interface Tab {
  /** Stable across repaints, so the rail can patch a row instead of rebuilding it. */
  readonly id: number;
  root: L.Node;
  active: Pane;
  el: HTMLElement;
  projectId: string | null;
  color: string | null;
  /** Set by the user; wins over whatever the shell calls itself. */
  name: string | null;
  /** Account whose environment this tab's shells were started with. */
  accountId: string | null;
  /** Set when the tab was opened on an SSH host. */
  hostId: string | null;
  /** Small stable integer, unique among open tabs — OBPTERM_SLOT for port/DB derivation. */
  slot: number;
}

export interface SavedTab {
  project: string | null;
  slot?: number;
  color: string | null;
  name?: string | null;
  account?: string | null;
  host?: string | null;
  root: L.SavedNode;
}

/** The four shapes the toolbar's layout picker draws. `currentPreset` reads them back. */
function presetTree(preset: Preset, p: Pane[]): L.Node {
  const split = (dir: "row" | "col", a: L.Node, b: L.Node): L.Node => ({ kind: "split", dir, ratio: 0.5, a, b });
  if (preset === "1") return L.leaf(p[0]!);
  if (preset === "2c") return split("row", L.leaf(p[0]!), L.leaf(p[1]!));
  if (preset === "2r") return split("col", L.leaf(p[0]!), L.leaf(p[1]!));
  return split("row", split("col", L.leaf(p[0]!), L.leaf(p[1]!)), split("col", L.leaf(p[2]!), L.leaf(p[3]!)));
}

let nextTabId = 1;

/** A copy of a claude profile must mint its own session — never share or resume the source's. */
/** Semantic-ish compare, enough for x.y.z release tags. */
function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

function stripSessionArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--session-id" || a === "--resume" || a === "-r") { i++; continue; }
    out.push(a);
  }
  return out;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const DEFAULT_ACCENT = "#ff8a1e";

export class App implements PaneHost {
  tabs: Tab[] = [];
  tab: Tab | null = null;
  find!: Find; // set by main.ts once the DOM handlers are installed
  status!: Status;
  toolbar!: { paint(): void };
  palette!: import("./palette").Palette;
  settings!: import("./settings-panel").Settings;
  nodes!: import("./nodes").Nodes;
  private panesEl = $("#panes");
  private sessionTimer = 0;
  /** Most recently used first. Only ever read through `recent()`. */
  private mru: Tab[] = [];
  /** The session host's instance id, or null when shells die with the window. */
  hostInstance: string | null = null;
  /** When an agent event (of any kind) last arrived — the proof the chain works. */
  lastAgentEventAt = 0;
  /** Whether any FAN-OUT event has ever arrived: the thing that draws ×N. */
  lastFanEventAt = 0;
  /** Host version reported at connect, so the panel can name a stale host. */
  hostVersion = "";
  appVersion = "";
  /** Which settings files carry our hook block, learned at boot. */
  hookDirs: string[] = [];

  /** One line saying why there are no agents, when there are none. */
  agentsDiagnosis(): string {
    const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)}s ago`;
    if (this.hostVersion && this.appVersion && olderThan(this.hostVersion, this.appVersion)) {
      return `session host is ${this.hostVersion}, app is ${this.appVersion} — restart the host (Quit and reopen) or agents stay invisible`;
    }
    if (!this.lastAgentEventAt) {
      return this.hookDirs.length
        ? `no hook events yet — hooks are in ${this.hookDirs.join(", ")}; if this stays empty while Claude works, the hooks are not reaching OBPTerm`
        : "Claude Code hooks are not installed — Settings ▸ Files can reinstall them";
    }
    if (!this.lastFanEventAt) return `hooks are live (last event ${ago(this.lastAgentEventAt)}) — no delegation seen yet`;
    return `last agent event ${ago(this.lastFanEventAt)}`;
  }

  /** Shells the host was holding when this window connected, by id. */
  private held = new Map<number, import("./transport").HostSession>();
  /** The same shells by Claude's own session id — an identity that outlives pty numbering. */
  private heldByClaude = new Map<string, import("./transport").HostSession>();
  /** Which held shells a restored pane has already taken, so two never claim one. */
  private claimed = new Set<number>();
  private reattachable = false;
  /** Panes that came back attached to a shell that never stopped. */
  reattached = 0;
  /** A shrink preset waiting for its second click. */
  armedPreset: Preset | null = null;
  private armedTimer = 0;
  private configTimer = 0;

  constructor(
    public tp: Transport,
    public config: Config,
  ) {
    $("#rail").classList.toggle("collapsed", config.rail_collapsed);
  }

  // ---- profiles & projects --------------------------------------------------------------

  profileById(id: string | null | undefined): Profile {
    const p = this.config.profiles.find((p) => p.id === id) ?? this.config.profiles[0];
    if (!p) throw new Error("config has no profiles");
    return p;
  }

  project(id: string | null): Project | null {
    return this.config.projects.find((p) => p.id === id) ?? null;
  }

  /** The colour a tab paints with: its own override, else its project's, else the house orange. */
  accent(tab: Tab | null = this.tab): string {
    return tab?.color ?? this.project(tab?.projectId ?? null)?.color ?? DEFAULT_ACCENT;
  }

  account(id: string | null | undefined): Account | null {
    return this.config.accounts.find((a) => a.id === id) ?? null;
  }

  host(id: string | null | undefined): Host | null {
    return this.config.hosts.find((h) => h.id === id) ?? null;
  }

  /** An SSH host is just a profile that runs ssh with the right arguments. */
  hostProfile(host: Host): Profile {
    const args = [host.user ? `${host.user}@${host.host}` : host.host];
    if (host.port) args.push("-p", String(host.port));
    if (host.identity) args.push("-i", host.identity);
    return {
      id: `host:${host.id}`,
      name: host.name,
      exe: navigator.userAgent.includes("Windows") ? "ssh.exe" : "ssh",
      args,
      cwd: null,
      env: {},
    };
  }

  async newTabForHost(host: Host) {
    const tab = await this.newTab(this.hostProfile(host), host.project ?? this.tab?.projectId ?? null);
    if (tab) {
      tab.hostId = host.id;
      this.paint();
      this.persistSession();
    }
    return tab;
  }

  /** The smallest slot no open tab holds. Slots are how per-session dev scripts stay apart:
   *  `$env:OBPTERM_SLOT` -> ports, DB names, compose project names. */
  private nextSlot(): number {
    const used = new Set(this.tabs.map((t) => t.slot));
    for (let n = 1; ; n++) if (!used.has(n)) return n;
  }

  /** Environment a shell starts with: the profile's own, then the account's, then the slot. */
  private withAccount(profile: Profile, accountId: string | null, slot?: number): Profile {
    const account = this.account(accountId);
    const merged = account ? { ...profile, env: { ...(profile.env ?? {}), ...account.env } } : { ...profile, env: { ...(profile.env ?? {}) } };
    if (slot) merged.env = { ...merged.env, OBPTERM_SLOT: String(slot) };
    // A Claude profile gets a session id we minted: hooks then track it through /clear and
    // /compact, and a reboot costs one --resume instead of a blank session.
    const hay = `${merged.exe} ${merged.args.join(" ")}`.toLowerCase();
    if (hay.includes("claude") && !merged.args.some((a) => a === "--session-id" || a === "--resume" || a === "-r" || a === "--continue" || a === "-c")) {
      merged.args = [...merged.args, "--session-id", crypto.randomUUID()];
    }
    return merged;
  }

  /**
   * Claude names every session; `/rename` never reaches the terminal title. Poll the
   * transcript's tail for the focused tab's Claude panes and let that name the tab, unless
   * the user has named it themselves.
   */
  async refreshAgentTitles() {
    const tab = this.tab;
    if (!tab) return;
    const account = this.account(tab.accountId);
    const dir = account?.claude_dir ?? "~/.claude";
    void this.refreshContext();
    for (const pane of L.panes(tab.root)) {
      if (!pane.claudeSessionId) continue;
      // The name only when the user has not chosen one; the gauge only for the pane whose gauge
      // is on screen — it is a 256 KB read and a JSON parse per pane, every five seconds.
      if (!tab.name) {
        const title = await this.tp.sessionTitle(dir, pane.claudeSessionId).catch(() => null);
        if (title && title !== pane.title) {
          pane.title = title;
          this.paint();
        }
      }
      if (pane === tab.active) pane.ctxPct = await this.tp.sessionContext(dir, pane.claudeSessionId).catch(() => null);
    }
    this.status?.paintCtx();
  }

  /**
   * The context gauge for every live Claude session, not just the one on screen — a background
   * session filling its window is exactly the one nobody is watching. Cheap by construction:
   * `session_context` caches on the transcript's size and mtime, so a quiet session costs one
   * `stat`. Panes past the warning line are said out loud once, the way a bell is.
   */
  private async refreshContext() {
    const warn = this.config.context_warn_pct;
    for (const tab of this.tabs) {
      const dir = this.account(tab.accountId)?.claude_dir ?? "~/.claude";
      for (const pane of L.panes(tab.root)) {
        if (!pane.claudeSessionId || pane.exited || pane.eco) continue;
        const before = pane.ctxPct;
        pane.ctxPct = await this.tp.sessionContext(dir, pane.claudeSessionId).catch(() => null);
        // Same pass, same file: what this conversation has spent. Both read the transcript and
        // both cache on how far they got, so a quiet session costs a `stat` and nothing else.
        pane.usage = await this.tp.sessionUsage(dir, pane.claudeSessionId, this.config.model_prices).catch(() => null);
        if (!warn || pane.ctxPct === null) continue;
        // Only on the crossing, and only once: a session sitting at 91% must not nag every poll.
        if (pane.ctxPct >= warn && (before === null || before < warn)) {
          this.agentAlert(this.title(tab), `context ${pane.ctxPct}% full — /compact soon`);
        }
      }
    }
    this.paintSoon();
  }

  /** What a tab has spent, in dollars — its panes summed. Null when nothing is known yet. */
  tabCost(tab: Tab): number | null {
    const costs = L.panes(tab.root).map((p) => p.usage?.cost_usd).filter((c): c is number => c !== undefined);
    return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  }

  /** Hand the focused pane's conversation to `/compact`. */
  compact(pane: Pane) {
    if (!pane.claudeSessionId || pane.exited) return;
    void this.tp.write(pane.id, "/compact\r").catch(() => {});
    toast("Compacting the conversation…");
  }

  /** The rail's verdict on a pane's held permission request. */
  async answerAgent(pane: Pane, allow: boolean) {
    const pending = pane.agent.pendingId;
    if (!pending) return;
    pane.agent.pendingId = null;
    pane.agent.state = allow ? "working" : "waiting";
    await this.tp.agentAnswer(pending, allow).catch(() => {});
    this.paint();
  }

  /** A pane whose Claude was put to sleep: run it again where it left off. */
  async resumeEco(pane: Pane) {
    if (!pane.eco) return;
    pane.eco = false;
    const sessionId = pane.claudeSessionId;
    const profile = { ...pane.profile };
    if (sessionId) {
      const args = [];
      for (let i = 0; i < profile.args.length; i++) {
        if (profile.args[i] === "--session-id") { i++; continue; }
        args.push(profile.args[i]!);
      }
      profile.args = [...args, "--resume", sessionId];
    }
    pane.profile = profile;
    await this.respawnPane(pane);
  }

  /**
   * Eco: a finished Claude session holds ~335 MB whether or not anyone reads its answer.
   * After a while unfocused and done, /exit it; the tab stays, marked, and focusing it
   * resumes the same conversation. Nothing is exited mid-turn, mid-question, or on screen.
   */
  ecoSweep() {
    const minutes = this.config.eco_after_minutes;
    const cutoff = Date.now() - (minutes || 0) * 60_000;
    // Eligible: a Claude session with a conversation to come back to, not on screen, not mid-
    // turn and not holding a question. A SLEEPING pane counts — that was the hole. Sleep frees
    // a terminal (a few MB); the ~400 MB is the `claude` process, and skipping asleep panes
    // meant eighteen of them held about seven gigabytes that nothing was ever going to reclaim.
    // Writing to a detached pane is fine: the host owns the pty either way.
    const eligible = () =>
      this.tabs
        .filter((t) => t !== this.tab)
        .flatMap((t) => L.panes(t.root))
        .filter(
          (p) =>
            !p.eco &&
            !p.exited &&
            p.id > 0 &&
            p.claudeSessionId &&
            (p.agent.state === "done" || p.agent.state === null) &&
            !p.agent.fanned.some((f) => f.endedAt === null),
        );

    if (minutes) {
      for (const pane of eligible()) {
        if (pane.agent.state !== "done") continue; // the timed path stays as it was: finished only
        if (pane.lastOutput > cutoff || pane.lastVisited > cutoff) continue;
        this.eco(pane);
      }
    }

    // Memory pressure. The machine running out of RAM is what actually freezes this window —
    // it thrashes on swap and everything stalls for minutes — and the sessions holding it are
    // idle ones nobody is reading. Above the threshold, the oldest of them are exited early;
    // the tab stays, and clicking it resumes the same conversation.
    const pct = this.config.eco_memory_pct;
    const m = this.status?.memoryPct() ?? null;
    if (!pct || m === null || m < pct) return;
    // Which idle session to exit is a question about bytes, not about clocks: a 40 MB shell and
    // a 2 GB session that has been fanning out all afternoon are both "idle", and only one of
    // them gives the machine anything back. Biggest first, with age as the tie-break for the
    // ones we have no measurement for.
    const queue = eligible().sort((a, b) => b.rss - a.rss || a.lastVisited - b.lastVisited);
    let freed = 0;
    let bytes = 0;
    for (const pane of queue) {
      if (freed >= 3) break; // a few per sweep, then look again — never a stampede
      bytes += pane.rss;
      this.eco(pane);
      freed++;
    }
    if (freed) {
      const gave = bytes ? ` (~${(bytes / 1e9).toFixed(1)} GB)` : "";
      toast(`Memory at ${Math.round(m)}% — ${freed} idle session${freed > 1 ? "s" : ""}${gave} exited to free it; click a tab to resume`);
    }
  }

  /** `/exit` a session and mark the tab: clicking it runs `claude --resume` on the same id. */
  private eco(pane: Pane) {
    pane.eco = true;
    void this.tp.write(pane.id, "/exit\r").catch(() => {});
  }

  /**
   * Adds a second Claude Code login the safe way: its own `CLAUDE_CONFIG_DIR`, then a tab under
   * that account running `claude auth login`. Nothing copies or rewrites a credential file —
   * Claude Code creates the folder and signs in itself.
   */
  async addClaudeAccount() {
    const home = this.config.default_cwd?.match(/^[A-Za-z]:/) ? "%USERPROFILE%" : "~";
    const n = this.config.accounts.length + 1;
    const account: Account = {
      id: `a${Date.now().toString(36)}`,
      name: `Account ${n}`,
      env: { CLAUDE_CONFIG_DIR: `${home}\\.claude-${n}` },
      claude_dir: `${home}\\.claude-${n}`,
      color: COLORS[n % COLORS.length]!.value,
    };
    this.config.accounts.push(account);
    this.persistConfig();
    this.paint();
    this.settings.open("accounts");
    toast("Set the folder for this account, then open a tab under it and run `claude auth login`");
    return account;
  }

  /** Opens a tab under `account` and runs the Claude Code login in it. */
  async signIn(account: Account) {
    const tab = await this.newTab(undefined, this.tab?.projectId ?? null, null, account.id);
    // Give the shell a moment to draw its prompt before typing into it.
    window.setTimeout(() => tab && this.sendKey("claude auth login\r"), 700);
  }

  addProject(name: string): Project {
    const used = new Set(this.config.projects.map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c.value))?.value ?? COLORS[0]!.value;
    const project: Project = {
      id: `p${Date.now().toString(36)}`,
      name,
      color,
      cwd: null,
      default_profile: null,
      layout: null,
      collapsed: false,
    };
    this.config.projects.push(project);
    this.persist();
    return project;
  }

  deleteProject(project: Project) {
    const index = this.config.projects.indexOf(project);
    if (index < 0) return;
    const orphans = this.tabs.filter((t) => t.projectId === project.id);
    this.config.projects.splice(index, 1);
    for (const t of orphans) t.projectId = null;
    this.persist();
    toast(`Deleted “${project.name}”`, {
      label: "Undo",
      run: () => {
        this.config.projects.splice(index, 0, project);
        for (const t of orphans) t.projectId = project.id;
        this.persist();
      },
    });
  }

  /** Stores the project's current tabs so it can be reopened as a workspace. */
  saveProjectLayout(project: Project) {
    const tabs = this.tabs.filter((t) => t.projectId === project.id).map((t) => this.snapshot(t));
    if (!tabs.length) return toast(`“${project.name}” has no open tabs to save`);
    project.layout = tabs;
    this.persist();
    toast(`Saved ${tabs.length} tab${tabs.length > 1 ? "s" : ""} as “${project.name}”`);
  }

  async openProjectLayout(project: Project) {
    const tabs = (project.layout ?? []) as SavedTab[];
    if (!tabs.length) return toast(`“${project.name}” has no saved layout`);
    // Opening it twice used to spawn a second set of shells, and the next Save wrote the
    // doubled set back to config.json.
    const open = this.tabs.filter((t) => t.projectId === project.id);
    if (open.length) {
      this.activate(open[0]!);
      return toast(`“${project.name}” is already open — close its tabs first to reopen the layout`);
    }
    for (const saved of tabs) await this.restoreTab({ ...saved, project: project.id });
  }

  /** The other half of "open the layout": put it away again. */
  closeProjectTabs(project: Project) {
    const tabs = this.tabs.filter((t) => t.projectId === project.id);
    if (!tabs.length) return toast(`“${project.name}” has no open tabs`);
    for (const tab of tabs) this.closeTab(tab);
    toast(`Closed ${tabs.length} tab${tabs.length > 1 ? "s" : ""} in “${project.name}”`);
  }

  // ---- tabs -----------------------------------------------------------------------------

  async newTab(
    profile?: Profile,
    projectId: string | null = this.tab?.projectId ?? null,
    cwd: string | null = null,
    accountId: string | null = this.tab?.accountId ?? this.config.default_account,
  ) {
    const project = this.project(projectId);
    const p = profile ?? this.profileById(project?.default_profile ?? this.config.default_profile);
    const slot = this.nextSlot();
    const pane = new Pane(this, this.withAccount(p, accountId, slot), cwd ?? project?.cwd ?? this.config.default_cwd);
    const el = document.createElement("div");
    el.className = "tab-panes";
    this.panesEl.appendChild(el);
    const tab: Tab = { id: nextTabId++, root: L.leaf(pane), active: pane, el, projectId, color: null, name: null, accountId, hostId: null, slot };
    this.tabs.push(tab);
    this.activate(tab);
    await this.startPane(tab, pane);
    void this.flushSession();
    return tab;
  }

  private async startPane(_tab: Tab, pane: Pane) {
    try {
      await pane.start();
    } catch (e) {
      // Closing the pane here cascades: last pane closes the tab, last tab closes the window.
      // A default profile of pwsh.exe on a machine without PowerShell 7 would take the app
      // down with Settings unreachable. Keep the pane, show why, let `r` retry.
      pane.exited = true;
      pane.exitAcknowledged = true;
      pane.exitCode = -1;
      pane.term.term.write(
        `\r\n\x1b[38;2;255;107;115m[${pane.profile.exe} could not start]\x1b[0m ${e}\r\n\r\n` +
          `  Fix the profile in Settings, then press \x1b[38;2;255;138;30mr\x1b[0m to try again.\r\n`,
      );
      toast(`Could not start ${pane.profile.name}: ${e}`);
    }
    this.paint();
  }

  closeTab(tab: Tab) {
    const lastCwd = tab.active.cwd;
    for (const p of L.panes(tab.root)) {
      p.kill();
      p.dispose();
    }
    if (lastCwd) this.offerWorktreeCleanup(lastCwd);
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.el.remove();
    if (this.tab === tab) {
      this.tab = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    this.paint();
    void this.flushSession();
    if (!this.tabs.length) {
      // Closing the last tab closes the window — through the Rust side, not the webview's own
      // `close()`, which depends on a capability and has failed silently here before.
      if (this.tp.native) void this.tp.windowAction("main", "close").catch(() => void this.newTab());
      else void this.newTab();
    }
  }

  activate(tab: Tab) {
    const accountChanged = this.tab?.accountId !== tab.accountId;
    this.tab = tab;
    for (const p of L.panes(tab.root)) {
      p.lastVisited = Date.now();
      p.agent.unread = false;
      if (p.asleep) void this.wakePane(p);
      if (p.eco) void this.resumeEco(p);
    }
    this.mru = [tab, ...this.mru.filter((t) => t !== tab && this.tabs.includes(t))];
    this.clearBells(tab);
    if (accountChanged) void this.status?.refresh();
    for (const t of this.tabs) t.el.classList.toggle("active", t === tab);
    this.layout(tab);
    tab.active.focus();
    this.paint();
  }

  /** Ctrl+Tab: back to the tab you were just in. Walking creation order is useless at twelve. */
  recent() {
    const previous = this.mru.find((t) => t !== this.tab && this.tabs.includes(t));
    if (previous) this.activate(previous);
  }

  /** Ctrl+Shift+Tab: the neighbour above in the rail — spatial, not historical. */
  cycle(delta: number) {
    if (!this.tab || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.tab);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]!);
  }

  /** Moves the focused tab up or down the rail, so Ctrl+1..9 can be made to mean something. */
  moveTab(tab: Tab, delta: number) {
    const from = this.tabs.indexOf(tab);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= this.tabs.length) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    // Moving across a group boundary adopts that group, which is what dragging it there means.
    tab.projectId = this.tabs[to + (delta > 0 ? -1 : 1)]?.projectId ?? tab.projectId;
    this.paint();
    void this.flushSession();
  }

  jump(index: number) {
    const t = this.tabs[index];
    if (t) this.activate(t);
  }

  moveTabToProject(tab: Tab, projectId: string | null) {
    tab.projectId = projectId;
    this.paint();
    this.persistSession();
  }

  setTabColor(tab: Tab, color: string | null) {
    tab.color = color;
    this.paint();
    this.persistSession();
  }

  title(tab: Tab): string {
    return tab.name || tab.active.title || tab.active.profile.name;
  }

  /** An empty name hands the tab back to whatever the shell calls itself. */
  renameTab(tab: Tab, name: string) {
    tab.name = name.trim() || null;
    this.paint();
    this.persistSession();
  }

  // ---- panes ----------------------------------------------------------------------------

  async splitPane(dir: "row" | "col", profile?: Profile) {
    const tab = this.tab;
    if (!tab) return;
    const from = tab.active;
    // A split inherits where you already are, so `cd` carries over when the shell reports it.
    const pane = new Pane(this, this.withAccount(profile ?? from.profile, tab.accountId, tab.slot), from.cwd);
    tab.root = L.split(tab.root, from, pane, dir);
    tab.active = pane;
    this.layout(tab);
    await this.startPane(tab, pane);
    pane.focus();
  }

  closePane(pane: Pane, tab = this.tabOf(pane)) {
    if (!tab) return;
    const next = L.remove(tab.root, pane);
    pane.kill();
    pane.dispose();
    if (!next) return this.closeTab(tab);
    tab.root = next;
    if (tab.active === pane) tab.active = L.panes(next)[0]!;
    this.layout(tab);
    tab.active.focus();
    this.paint();
    this.persistSession();
  }

  focusPane(pane: Pane) {
    const tab = this.tabOf(pane);
    if (!tab) return;
    tab.active = pane;
    pane.bell = false;
    // Focus the TERMINAL, not just the record of which pane is active: a pane you clicked
    // that never took keyboard focus swallows everything you type at it — which is what a
    // session sitting on a prompt looks like when it "will not respond".
    if (!pane.asleep && !pane.exited) pane.focus();
    this.paintFocus(tab);
    this.paint();
  }

  /** Right-click ▸ Reload: end this Claude session and start it again on the same
   *  conversation. The way out of a session stuck on a prompt, or one whose terminal has
   *  drifted from the shell. Non-Claude panes simply respawn. */
  async reloadPane(pane: Pane) {
    const tab = this.tabOf(pane);
    if (!tab) return;
    const sessionId = pane.claudeSessionId;
    pane.kill();
    // A fresh terminal, so nothing of the wedged screen survives.
    pane.term.term.reset();
    // `--resume` belongs in a CLAUDE profile's arguments; a shell you typed `claude` into
    // must be resumed by typing it again, or the shell is handed a flag it cannot parse and
    // dies on the spot.
    const runsClaude = `${pane.profile.exe} ${pane.profile.args.join(" ")}`.toLowerCase().includes("claude");
    let typeResume: string | null = null;
    if (sessionId) {
      const args = stripSessionArgs(pane.profile.args);
      if (runsClaude) pane.profile = { ...pane.profile, args: [...args, "--resume", sessionId] };
      else typeResume = sessionId;
    }
    pane.eco = false;
    pane.linkLost = false;
    await this.respawnPane(pane);
    // The recorded directory can be gone (a swept worktree, a renamed repo). Do not let that
    // turn a reload into a dead pane: try once more from the default directory.
    if (pane.exited && pane.cwd) {
      pane.cwd = this.config.default_cwd ?? null;
      pane.exited = false;
      pane.exitAcknowledged = false;
      pane.exitCode = null;
      pane.term.term.reset();
      await this.respawnPane(pane);
    }
    if (typeResume && !pane.exited && pane.id > 0) {
      const id = typeResume;
      window.setTimeout(() => !pane.exited && void this.tp.write(pane.id, `claude --resume ${id}\r`).catch(() => {}), 900);
    }
    toast(sessionId ? "Reloaded — resuming the same conversation" : "Reloaded");
  }

  moveFocus(dir: "left" | "right" | "up" | "down") {
    const tab = this.tab;
    if (!tab) return;
    const next = L.neighbour(tab.root, tab.active, dir);
    if (!next) return;
    tab.active = next;
    next.focus();
    this.paintFocus(tab);
    this.paint();
  }

  resizePane(dir: "left" | "right" | "up" | "down") {
    const tab = this.tab;
    if (!tab) return;
    const axis = dir === "left" || dir === "right" ? "row" : "col";
    const delta = dir === "left" || dir === "up" ? -0.03 : 0.03;
    if (L.nudge(tab.root, tab.active, axis, delta)) {
      this.layout(tab);
      this.persistSession();
    }
  }

  /** Restarts a dead pane's shell in place, keeping its terminal and scrollback. */
  async respawnPane(pane: Pane) {
    const tab = this.tabOf(pane);
    if (!tab || pane.deadReason) return;
    pane.exited = false;
    pane.exitAcknowledged = false;
    pane.exitCode = null;
    pane.id = -1;
    pane.term.term.write("\r\n\x1b[38;2;140;160;190m[reconnecting…]\x1b[0m\r\n");
    await this.startPane(tab, pane);
    pane.focus();
    this.paint();
  }

  /** Sends a literal string to the focused pane, e.g. "\x03" for Ctrl+C. */
  sendKey(data: string) {
    const pane = this.tab?.active;
    if (!pane || pane.exited) return;
    void this.tp.write(pane.id, data).catch(() => {});
    pane.focus();
  }

  clearPane() {
    const pane = this.tab?.active;
    if (!pane) return;
    pane.term.term.clear();
    pane.focus();
  }

  /** Which toolbar preset the tab currently matches, if any. */
  currentPreset(tab: Tab): Preset | null {
    const root = tab.root;
    if (root.kind === "leaf") return "1";
    const twoLeaves = root.a.kind === "leaf" && root.b.kind === "leaf";
    if (twoLeaves) return root.dir === "row" ? "2c" : "2r";
    const quad =
      root.dir === "row" &&
      root.a.kind === "split" &&
      root.b.kind === "split" &&
      root.a.dir === "col" &&
      root.b.dir === "col" &&
      L.panes(root).length === 4;
    return quad ? "4" : null;
  }

  /**
   * Snaps the tab to a preset: extra panes are closed, missing ones spawned from the focused
   * pane's profile and directory, then the tree is rebuilt in the shape the button draws.
   */
  async applyPreset(preset: Preset) {
    const tab = this.tab;
    if (!tab) return;
    const want = preset === "1" ? 1 : preset === "4" ? 4 : 2;
    const existing = L.panes(tab.root);
    const doomed = existing.slice(want).filter((p) => !p.exited);
    // Killing a shell cannot be undone, so a shrink that would end running shells asks once.
    if (doomed.length && this.armedPreset !== preset) {
      this.armedPreset = preset;
      clearTimeout(this.armedTimer);
      this.armedTimer = window.setTimeout(() => {
        this.armedPreset = null;
        this.toolbar?.paint();
      }, 5000);
      this.toolbar?.paint();
      toast(`That ends ${doomed.length} running shell${doomed.length > 1 ? "s" : ""} — click again to confirm`);
      return;
    }
    this.armedPreset = null;
    clearTimeout(this.armedTimer);
    for (const extra of existing.slice(want)) {
      extra.kill();
      extra.dispose();
    }
    const panes = existing.slice(0, want);
    while (panes.length < want) {
      const from = panes[panes.length - 1]!;
      panes.push(new Pane(this, this.withAccount(from.profile, tab.accountId, tab.slot), from.cwd));
    }
    tab.root = presetTree(preset, panes);
    tab.active = panes[0]!;
    this.layout(tab);
    for (const pane of panes) {
      if (pane.id < 0) await this.startPane(tab, pane);
    }
    tab.active.focus();
    this.paint();
    void this.flushSession();
  }

  async toggleLog() {
    const pane = this.tab?.active;
    if (!pane) return;
    try {
      const path = await pane.toggleLog();
      toast(path ? `Capturing to ${path}` : "Capture stopped");
      this.paint();
    } catch (e) {
      toast(`Capture failed: ${e}`);
    }
  }

  private tabOf(pane: Pane): Tab | null {
    return this.tabs.find((t) => L.findLeaf(t.root, pane)) ?? null;
  }

  private layout(tab: Tab) {
    L.render(tab.root, tab.el, () => this.persistSession());
    this.paintFocus(tab);
    for (const p of L.panes(tab.root)) p.term.fit();
  }

  /** The pane the sheen last acknowledged, so it plays once per focus change. */
  private lastFocusPane: Pane | null = null;

  /** A pane whose shell is gone wears a strip that says so and offers the one fix. */
  private paintLinkLost(pane: Pane) {
    let strip = pane.el.querySelector<HTMLElement>(".lost");
    if (!pane.linkLost) {
      strip?.remove();
      return;
    }
    if (strip) return;
    strip = document.createElement("div");
    strip.className = "lost";
    strip.innerHTML = `<span>This pane's shell is gone — what you see is history, and typing goes nowhere.</span><button>Reload session</button>`;
    strip.querySelector("button")!.onclick = () => void this.reloadPane(pane);
    pane.el.appendChild(strip);
  }

  private paintFocus(tab: Tab) {
    const many = L.panes(tab.root).length > 1;
    for (const p of L.panes(tab.root)) {
      p.el.classList.toggle("focused", many && p === tab.active);
      // While this pane's agent holds a question, its border light orbits until answered.
      p.el.classList.toggle("asking", p.agent.state === "blocked" || p.agent.state === "waiting");
      p.el.style.setProperty("--pane-accent", this.accent(tab));
    }
    // One sweep of light when focus arrives somewhere new — acknowledged, then still.
    if (tab.active !== this.lastFocusPane) {
      this.lastFocusPane = tab.active;
      const el = tab.active.el;
      el.classList.remove("sheen");
      void el.offsetWidth; // restart the animation when re-added
      el.classList.add("sheen");
      window.setTimeout(() => el.classList.remove("sheen"), 950);
    }
  }

  // ---- PaneHost -------------------------------------------------------------------------

  onPaneTitle() {
    this.paint();
    this.persistSession();
  }

  onPaneExit(pane: Pane, code: number | null) {
    const tab = this.tabOf(pane);
    if (!tab) return;
    if (pane.eco) {
      // The /exit we sent on purpose: hold the pane, say so, wake resumes.
      pane.exited = true;
      pane.exitAcknowledged = true;
      pane.term.term.write("\r\n\x1b[38;2;118;135;156m[agent sleeping to save memory — click or press any key to resume]\x1b[0m\r\n");
      this.paint();
      void this.flushSession();
      return;
    }
    if (code === 0 || code === null || pane.exitAcknowledged) return this.closePane(pane, tab);
    // Non-zero: leave the output on screen, close on the next keypress.
    pane.exitAcknowledged = true;
    pane.exitCode = code;
    pane.term.term.write(
      `\r\n\x1b[38;2;255;107;115m[${pane.profile.exe} exited with code ${code}]\x1b[0m  ` +
        `press \x1b[38;2;255;138;30mr\x1b[0m to run it again, any other key to close\r\n`,
    );
    this.paint();
  }

  onPaneFocus(pane: Pane) {
    this.focusPane(pane);
  }

  onPaneRespawn(pane: Pane) {
    void this.respawnPane(pane);
  }

  onPaneReattached(_pane: Pane) {
    this.reattached += 1;
  }

  /** A program asked for attention by name — the payload OSC 9 was carrying all along. */
  onPaneNotify(pane: Pane, title: string, body: string) {
    if (this.isFocused(pane)) return;
    pane.bell = true;
    this.onPaneActivity();
    this.alert(title || pane.profile.name, body);
  }

  /** An agent asked for something, in its own words. */
  agentAlert(title: string, body: string) {
    this.alert(title, body);
  }

  /** One place for "tell the user something happened while they were elsewhere". */
  private alert(title: string, body: string) {
    if (!this.config.notify_bell) return;
    void this.tp.notify(title, body).catch(() => {});
    void this.tp.attention(true).catch(() => {});
    // The phone, but only when the window itself is in the background — a push for every
    // background-tab event while actively working here would be spam.
    if (this.config.ntfy_url && !document.hasFocus()) {
      void this.tp.ntfy(this.config.ntfy_url, this.config.ntfy_token, title, body).catch(() => {});
    }
  }

  /**
   * A pane that was busy and has gone quiet is the completion signal that needs nothing from
   * the shell — no bell, no shell integration, and it works over SSH.
   */
  private checkSilence() {
    if (!this.config.notify_silence) return;
    const quiet = this.config.silence_seconds * 1000;
    for (const tab of this.tabs) {
      for (const pane of L.panes(tab.root)) {
        const busyFor = pane.lastOutput - pane.busySince;
        if (!pane.busySince || pane.exited || this.isFocused(pane)) continue;
        if (Date.now() - pane.lastOutput < quiet) continue;
        // Only worth saying for something that actually ran for a while.
        if (busyFor > 5000) {
          pane.bell = true;
          this.alert(this.title(tab), `quiet for ${this.config.silence_seconds}s — probably finished`);
        }
        pane.busySince = 0;
      }
    }
  }

  isFocused(pane: Pane): boolean {
    return this.tab?.active === pane && document.hasFocus();
  }

  /** Coming back to the window clears the flashing. */
  clearAttention() {
    void this.tp.attention(false).catch(() => {});
  }

  /** A pane started or stopped printing, or rang: the rail's dots are stale. */
  onPaneActivity() {
    this.checkSilence();
    for (const tab of this.tabs) {
      for (const pane of L.panes(tab.root)) {
        pruneFan(pane.agent);
        if (agentTick(pane.agent)) {
          // fell stale; nothing else to do — the repaint below shows it
        }
      }
    }
    renderRail(this);
    // The orbit rim must follow the agent state without a full repaint.
    const tab = this.tab;
    if (tab) {
      for (const p of L.panes(tab.root)) {
        p.el.classList.toggle("asking", p.agent.state === "blocked" || p.agent.state === "waiting");
      }
    }
  }

  /**
   * Tabs nobody has looked at for a while lose their terminals — an xterm with a 10k-line
   * buffer and a WebGL context each is the window's real memory cost, and a dozen of them is
   * most of it. The shells keep running in the host; clicking the tab brings the terminal
   * back with the shell's recent output.
   */
  /** Every awake pane, oldest visit first. */
  private awakePanes(): Pane[] {
    return this.tabs
      .flatMap((t) => L.panes(t.root))
      .filter((p) => !p.asleep && !p.exited && p.id > 0)
      .sort((a, b) => a.lastVisited - b.lastVisited);
  }

  /**
   * Wakes a pane, and keeps the window under its ceiling while doing it. A live terminal holds
   * a WebGL context; past about sixteen Chromium takes them back, every terminal that loses one
   * falls back to the DOM renderer, and the window seizes. So the oldest awake pane goes to
   * sleep to make room — its shell keeps running, and it wakes on click like any other.
   */
  async wakePane(pane: Pane) {
    await pane.wake();
    const cap = this.config.max_live_panes;
    if (cap) {
      const current = this.tab ? L.panes(this.tab.root) : [];
      const spare = this.awakePanes().filter((p) => p !== pane && !current.includes(p));
      let slept = 0;
      while (spare.length && spare.length + current.length > cap) {
        const oldest = spare.shift()!;
        if (oldest.agent.state === "blocked" || oldest.agent.state === "waiting") continue;
        await oldest.sleep();
        slept++;
      }
      if (slept) toast(`${slept} background session${slept > 1 ? "s" : ""} put to sleep — click one to wake it`);
    }
    this.paint();
  }

  async sleepIdleTabs() {
    const seconds = this.config.sleep_after_seconds;
    if (!seconds || !this.hostInstance) return;
    const cutoff = Date.now() - seconds * 1000;
    let slept = 0;
    for (const tab of this.tabs) {
      if (tab === this.tab) continue;
      for (const p of L.panes(tab.root)) {
        // A pane holding a permission question keeps its shell: the rail's Allow/Deny writes
        // to it, and answering a question through a torn-down terminal is not a thing.
        if (p.agent.state === "blocked" || p.agent.state === "waiting") continue;
        if (!p.asleep && !p.exited && p.id > 0 && p.lastVisited < cutoff && !p.logPath) {
          await p.sleep();
          slept++;
        }
      }
    }
    if (slept) this.paint();
  }

  /** Sleeping panes cannot see their own output; the host says what happened meanwhile. */
  async refreshHeld() {
    if (!this.hostInstance) return;
    const all = this.tabs.flatMap((t) => L.panes(t.root));
    const sleeping = all.filter((p) => p.asleep);
    const sessions = await this.tp.listSessions().catch(() => []);
    // A pane whose shell the host no longer holds shows replayed history and swallows every
    // keystroke. Mark it, so the pane can say so instead of looking alive.
    const live = new Set(sessions.filter((s) => s.exited === null).map((s) => s.id));
    let lostChanged = false;
    for (const p of all) {
      const lost = p.id > 0 && !p.exited && !live.has(p.id);
      if (lost !== p.linkLost) {
        p.linkLost = lost;
        lostChanged = true;
      }
    }
    if (lostChanged) this.paint();

    // What each session's process tree is holding. `rss_for` was written for this and never
    // called: at 98% RAM the difference between a 40 MB shell and a 2 GB stuck session is the
    // whole decision, and nothing was asking. One batched call for every pid the host knows.
    const pids = sessions.map((s) => s.pid).filter((p): p is number => !!p);
    if (pids.length) {
      const rss = await this.tp.rssFor(pids).catch(() => []);
      const byPid = new Map(pids.map((pid, i) => [pid, rss[i] ?? 0]));
      const pidOf = new Map(sessions.map((s) => [s.id, s.pid]));
      for (const p of all) {
        const pid = pidOf.get(p.id);
        const bytes = pid ? byPid.get(pid) ?? 0 : 0;
        if (bytes) p.rss = bytes;
      }
    }

    // The host tracks agent state through hooks even with no window attached — and a restored
    // pane threw that away and showed "idle" until the session's next hook, which after a
    // reboot is exactly when the rail has to be honest. Adopt what the host already knows,
    // but never over a live pane's own state: ours is fresher.
    for (const p of all) {
      if (p.agent.state !== null) continue;
      const held = sessions.find((x) => x.id === p.id);
      if (!held?.agent_state) continue;
      const known = ["working", "done", "waiting", "blocked"] as const;
      const state = known.find((k) => k === held.agent_state);
      if (!state) continue;
      p.agent.state = state;
      p.agent.detail = held.agent_detail;
      if (held.claude_session_id) p.claudeSessionId = held.claude_session_id;
      this.paintSoon();
    }

    if (!sleeping.length) return;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    let changed = false;
    for (const p of sleeping) {
      const held = byId.get(p.id);
      if (!held) continue;
      const next = { last_output: held.last_output, bell: held.bell, exited: held.exited };
      if (JSON.stringify(next) !== JSON.stringify(p.heldState)) changed = true;
      p.heldState = next;
    }
    if (changed) this.paint();
  }

  async wakeAll() {
    for (const p of this.tabs.flatMap((t) => L.panes(t.root))) if (p.asleep) await p.wake();
    this.paint();
  }

  /** Ends every shell and the host with them, then closes. Closing the window never does this. */
  async quitAll() {
    await this.flushSession();
    await this.tp.hostShutdown().catch(() => {});
    // Through the Rust side, not the webview's own `close()`: that path depends on a capability
    // and failed silently once already, leaving Quit as a button that did nothing.
    if (this.tp.native) await this.tp.windowAction("main", "close").catch((err) => toast(`Can't quit: ${err}`));
  }

  /** Swap a stale session host for a current one without closing the window. The shells it
   *  held cannot survive that — but the tabs do: the reload restores them, Claude panes with
   *  `--resume`, so nothing has to be reopened by hand. */
  async restartHost() {
    toast("Restarting the session host…");
    await this.flushSession();
    try {
      const version = await this.tp.hostRestart();
      toast(`Session host is now ${version} — restoring your tabs`);
      window.setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      toast(`Could not restart the host: ${e}`);
    }
  }

  sleepingCount(): number {
    return this.tabs.flatMap((t) => L.panes(t.root)).filter((p) => p.asleep).length;
  }

  /** What one pane is doing right now. Hook-derived truth outranks the byte heuristics. */
  paneActivity(pane: Pane): Activity {
    if (pane.eco) return "idle";
    const agent = pane.agent.state;
    if (agent === "blocked" || agent === "waiting") return "bell";
    if (agent === "done" && pane.agent.unread) return "unread";
    if (agent === "working") return "running";
    if (pane.asleep) {
      // The host's word, refreshed every few seconds.
      const h = pane.heldState;
      if (!h) return "idle";
      if (h.exited !== null && h.exited !== 0) return "exited";
      if (h.bell) return "bell";
      return Date.now() - h.last_output < ACTIVE_MS ? "running" : "idle";
    }
    if (pane.exited) return pane.exitCode ? "exited" : "idle";
    if (pane.bell) return "bell";
    return Date.now() - pane.lastOutput < ACTIVE_MS ? "running" : "idle";
  }

  /** What a tab reports: the loudest of its panes. */
  activity(tab: Tab): Activity {
    const states = L.panes(tab.root).map((p) => this.paneActivity(p));
    return LOUDNESS.find((s) => states.includes(s)) ?? "idle";
  }

  /** Tabs whose bell has not been answered. */
  waiting(): number {
    return this.tabs.filter((t) => this.activity(t) === "bell").length;
  }

  /** Focusing a tab answers its bell. */
  private clearBells(tab: Tab) {
    for (const pane of L.panes(tab.root)) pane.bell = false;
  }

  onPaneSelection(text: string) {
    void this.tp.writeClipboard(text).catch(() => {});
  }

  // ---- config & session -------------------------------------------------------------------

  applyConfig() {
    const root = document.documentElement.style;
    root.setProperty("--term-bg", this.config.theme.background ?? "#0a0e14");
    root.setProperty("--mono", this.config.font_family);
    root.setProperty("--accent", this.config.accent);
    // Keep the fill in step with the accent, or a re-coloured app keeps orange buttons.
    root.setProperty(
      "--accent-fill",
      `linear-gradient(135deg, color-mix(in srgb, ${this.config.accent} 78%, white), ${this.config.accent})`,
    );
    document.body.classList.toggle("dim-inactive", this.config.dim_inactive_panes);
    for (const t of this.tabs) {
      for (const p of L.panes(t.root)) applyTermConfig(p.term.term, this.config);
      this.layout(t);
    }
  }

  zoom(delta: number) {
    this.config.font_size = delta === 0 ? 14 : Math.min(40, Math.max(8, this.config.font_size + delta));
    this.applyConfig();
    this.persistConfig();
  }

  toggleRail() {
    this.config.rail_collapsed = $("#rail").classList.toggle("collapsed");
    this.applyRailWidth();
    this.persistConfig();
  }

  setRailWidth(px: number) {
    this.config.rail_width = Math.round(Math.min(420, Math.max(150, px)));
    this.applyRailWidth();
    this.persistConfig();
  }

  applyRailWidth() {
    document.documentElement.style.setProperty("--rail-w", `${this.config.rail_width}px`);
    for (const t of this.tabs) for (const p of L.panes(t.root)) p.term.fit();
  }

  toggleProject(project: Project) {
    project.collapsed = !project.collapsed;
    this.paint();
    this.persistConfig();
  }


  /** What the Agents entry, the Deck header and the taskbar badge all count. */
  agentCounts() {
    let needsYou = 0, working = 0, done = 0, doneUnread = 0, sleeping = 0, total = 0;
    let loudest: string | null = null;
    for (const tab of this.tabs) {
      for (const p of this.panesOf(tab)) {
        if (!isClaudePane(p)) continue;
        total++;
        if (p.eco || p.asleep) { sleeping++; continue; }
        const s = p.agent.state;
        if (s === "blocked" || s === "waiting") {
          needsYou++;
          loudest ??= `${this.title(tab)} · ${p.agent.detail ?? "needs you"}`;
        } else if (s === "working") working++;
        else if (s === "done") { done++; if (p.agent.unread) doneUnread++; }
      }
    }
    return { total, needsYou, working, done, doneUnread, sleeping, loudest };
  }

  /** The taskbar overlay mirrors the rail badge; only redrawn when the number changes. */
  private lastBadge = -1;
  private syncBadge(needsYou: number) {
    if (needsYou === this.lastBadge) return;
    this.lastBadge = needsYou;
    void this.tp.badge(needsYou).catch(() => {});
  }

  /** Sleep inhibitor follows "any agent working"; the chip makes the behaviour visible. */
  private lastAwake = false;
  private syncAwake(working: boolean) {
    const on = working && this.config.keep_awake;
    document.querySelector<HTMLElement>("#awake")!.hidden = !on;
    if (on === this.lastAwake) return;
    this.lastAwake = on;
    void this.tp.keepAwake(on).catch(() => {});
  }

  /** The two surfaces the rail switches between: the terminal, and the agents map. */
  showView(view: "sessions" | "agents") {
    if (view === "agents") this.nodes.open();
    else this.nodes.close();
    this.config.agents_view = view;
    this.persistConfig();
    this.paint();
  }

  toggleAgentsView() {
    this.showView(this.nodes.isOpen ? "sessions" : "agents");
  }

  /** Ctrl+Shift+G: the next Claude session that waits on the user, cycling. */
  jumpNeedsYou() {
    const list: { pane: Pane; tab: Tab }[] = [];
    for (const tab of this.tabs) {
      for (const pane of this.panesOf(tab)) {
        if (pane.agent.state === "blocked" || pane.agent.state === "waiting") list.push({ pane, tab });
      }
    }
    // A dangerous held request is always the next stop.
    list.sort((a, b) => Number(isDangerous(b.pane.agent)) - Number(isDangerous(a.pane.agent)));
    if (!list.length) return;
    const current = list.findIndex(({ pane }) => pane === this.tab?.active);
    const next = list[(current + 1) % list.length]!;
    this.activate(next.tab);
    this.focusPane(next.pane);
  }

  /** Ctrl+Shift+U: a sibling worktree (`<repo>-<name>`, branch `<name>`) with a tab in it —
   *  the parallel-agent move: same repo, isolated files. */
  async newWorktreeTab(name: string) {
    const from = this.tab;
    const cwd = from?.active.cwd ?? this.config.default_cwd;
    if (!cwd) return toast("Open a tab inside the repository first");
    try {
      const path = await this.tp.worktreeAdd(cwd, name.trim());
      const tab = await this.newTab(from ? { ...from.active.profile, args: stripSessionArgs(from.active.profile.args) } : undefined, from?.projectId ?? null, path, from?.accountId);
      if (tab) this.renameTab(tab, name.trim());
      toast(`Worktree ${path} on branch ${name.trim()}`);
    } catch (e) {
      toast(`Worktree not created: ${e}`);
    }
  }

  /** Closing a tab that lived in a merged, clean worktree offers to sweep it — creation gets
   *  a matching deletion, and dead checkouts stop piling up. */
  private offerWorktreeCleanup(cwd: string) {
    void this.tp
      .worktreeStatus(cwd)
      .then((wt) => {
        if (!wt || !wt.clean || !wt.merged) return;
        toast(`${wt.branch} is merged — its worktree is still on disk`, {
          label: "Remove it",
          run: () =>
            void this.tp
              .worktreeRemove(wt.main_root, wt.path, wt.branch)
              .then(() => toast(`Removed ${wt.path} and branch ${wt.branch}`))
              .catch((e) => toast(`Not removed: ${e}`)),
        });
      })
      .catch(() => {});
  }

  /** Ctrl+Shift+Y: the session's diff in a split — the review step, next to the work. */
  async reviewSplit() {
    const tab = this.tab;
    if (!tab) return;
    const from = tab.active;
    await this.splitPane("row");
    // The new split is now the active pane; give its shell a beat, then ask for the diff.
    const pane = tab.active;
    window.setTimeout(() => {
      if (!pane.exited && pane.id > 0) void this.tp.write(pane.id, "git diff\r").catch(() => {});
    }, 900);
    void from; // the split already inherited its cwd
  }

  /** A second shell exactly where you are: profile, project, account and current directory. */
  async duplicateTab() {
    const tab = this.tab;
    if (!tab) return;
    await this.newTab({ ...tab.active.profile, args: stripSessionArgs(tab.active.profile.args) }, tab.projectId, tab.active.cwd, tab.accountId);
  }

  /** Repaint the rail. Cheap: the rail is the only derived view. */
  /**
   * A repaint at the next frame, and only one however many times it was asked for. Hook events
   * arrive in bursts — a ten-agent fan-out is a PreToolUse and a PostToolUse per tool call per
   * agent — and each one used to repaint the rail, the deck and the map synchronously. The
   * screen cannot show more than one frame anyway.
   */
  paintSoon() {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paint();
    });
  }
  private paintQueued = false;

  paint() {
    renderRail(this);
    this.nodes?.paint();
    for (const tab of this.tabs) for (const p of L.panes(tab.root)) this.paintLinkLost(p);
    const counts = this.agentCounts();
    this.syncBadge(counts.needsYou);
    this.syncAwake(counts.working > 0);
    this.status?.paint();
    this.toolbar?.paint();
    // Scoped to the workbench: the settings sheet is app chrome and keeps the configured
    // accent, so a rose tab cannot leave an orange nav pill beside rose controls.
    document.querySelector<HTMLElement>("#workbench")!.style.setProperty("--accent", this.accent());
  }

  /** The settings window saved something: take its copy without dropping any shells. */
  async reloadConfig() {
    const fresh = withDefaults(await this.tp.loadConfig());
    // The session lives in session.json; everything else comes from the file.
    Object.assign(this.config, fresh);
    bindKeys(this.config);
    this.applyConfig();
    this.applyRailWidth();
    document.querySelector("#rail")!.classList.toggle("collapsed", this.config.rail_collapsed);
    this.paint();
  }

  snapshot(tab: Tab): SavedTab {
    return {
      project: tab.projectId,
      slot: tab.slot,
      color: tab.color,
      name: tab.name,
      account: tab.accountId,
      host: tab.hostId,
      root: L.serialize(tab.root),
    };
  }

  paneCount(tab: Tab): number {
    return L.panes(tab.root).length;
  }

  panesOf(tab: Tab): Pane[] {
    return L.panes(tab.root);
  }

  /** Both stores, for the call sites that change something in each. */
  persist() {
    this.persistSession();
    this.persistConfig();
  }

  /**
   * The open tabs, written to their own small file. Debounced hard (250 ms) and flushed by
   * `installCrashGuard`, because this is what a crash has to leave behind.
   */
  persistSession() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = window.setTimeout(() => void this.flushSession(), 250);
  }

  /** Writes the tabs now. Always writes: a caller asking for a flush is about to lose the process. */
  async flushSession() {
    clearTimeout(this.sessionTimer);
    const active = Math.max(0, this.tab ? this.tabs.indexOf(this.tab) : 0);
    await this.tp
      .sessionSave(this.tabs.map((t) => this.snapshot(t)), active, this.hostInstance)
      .catch((e) => console.warn("session not saved", e));
  }

  /** config.json — projects, accounts, fonts. Changes rarely; the user edits this file too. */
  persistConfig() {
    clearTimeout(this.configTimer);
    this.configTimer = window.setTimeout(() => {
      void this.tp.saveConfig(this.config).catch((e) => toast(`Config not saved: ${e}`));
    }, 600);
  }

  /** Returns how the last run ended, so main.ts can say so when it was not a clean exit. */
  /**
   * Learns what the host is holding. A saved pty id is only honoured against the instance
   * that minted it: a host that restarted reuses numbers, and the wrong shell behind a tab
   * that still calls itself the VPS is the one bug this must never have.
   */
  async connectHost(): Promise<void> {
    const info = await this.tp.hostInfo().catch(() => null);
    this.hostInstance = info?.connected ? info.instance : null;
    if (!this.hostInstance) return;
    // The host deliberately outlives an update — which means a new window can be talking to a
    // host that predates the features it is drawing (agent fan-out arrived in 0.18). Say so,
    // and offer the one action that fixes it: end the shells, restart on the new host.
    const mine = await this.tp.appVersion().catch(() => "");
    this.hostVersion = info?.version ?? "";
    this.appVersion = mine;
    if (info && mine && olderThan(info.version, mine)) {
      toast(`Shells are still on the older session host ${info.version} — agents stay invisible until it restarts`, {
        label: "Restart host",
        run: () => void this.restartHost(),
      });
    }
    const sessions = await this.tp.listSessions().catch(() => []);
    this.held = new Map(sessions.map((s) => [s.id, s]));
    this.heldByClaude = new Map(
      sessions.filter((s) => s.exited === null && s.claude_session_id).map((s) => [s.claude_session_id!, s]),
    );
  }

  /** How many of the host's shells no tab in this window is showing. */
  orphanedSessions(): number {
    const shown = new Set(this.tabs.flatMap((t) => L.panes(t.root).map((p) => p.id)));
    return [...this.held.keys()].filter((id) => !shown.has(id)).length;
  }

  async restoreSession(): Promise<{ restored: number; crashed: boolean; updatedTo: string | null }> {
    if (!this.config.restore_session) return { restored: 0, crashed: false, updatedTo: null };
    const session = await this.tp.sessionLoad().catch(() => null);
    // Ids from another host instance are just numbers; those panes respawn instead.
    this.reattachable = !!this.hostInstance && session?.host === this.hostInstance;
    const saved = (session?.tabs as SavedTab[] | null) ?? [];
    this.claimed.clear();
    let restored = 0;
    const list = Array.isArray(saved) ? saved : [];
    // Everything except the tab that will be in front comes back asleep. Restoring twenty live
    // terminals at once is the worst moment the window has, and nineteen of them were for tabs
    // nobody was looking at.
    const front = Math.min(session?.active ?? 0, list.length - 1);
    for (const [i, tab] of list.entries()) {
      if (await this.restoreTab(tab, i !== front)) restored++;
    }
    // Activate once, at the end, on the tab that was in front — not on whichever happened to
    // be built last, and without repainting the whole rail per restored tab.
    const target = this.tabs[Math.min(session?.active ?? 0, this.tabs.length - 1)];
    if (target) this.activate(target);
    return {
      restored,
      crashed: restored > 0 && session?.clean_exit === false && !this.reattached,
      updatedTo: session?.updated_to ?? null,
    };
  }

  /**
   * Rebuilds one saved pane. A saved tab can outlive the host or profile it names — deleted in
   * Settings, or a session.json newer than config.json — and quietly falling back to the first
   * profile would put a local shell behind a tab that still calls itself the VPS.
   */
  private restorePane(node: L.SavedNode, saved: SavedTab): Pane {
    const wanted = node.profile ?? "";
    const hostId = wanted.startsWith("host:") ? wanted.slice(5) : null;
    const host = hostId ? this.host(hostId) : null;
    const profile = host ? this.hostProfile(host) : this.config.profiles.find((p) => p.id === wanted);
    if (profile) {
      let effective = this.withAccount(profile, saved.account ?? null, saved.slot);
      // Two ways home, in order of certainty. The pty number is only meaningful against the
      // host instance that minted it; Claude's session id is the shell's own identity and
      // survives anything short of that shell ending — which is what makes a restore after an
      // update a REATTACH rather than ten sessions resuming from scratch.
      let held = this.reattachable && node.pty ? this.held.get(node.pty) : undefined;
      if (!held && node.claude) {
        const byIdentity = this.heldByClaude.get(node.claude);
        if (byIdentity && !this.claimed.has(byIdentity.id)) held = byIdentity;
      }
      if (held) this.claimed.add(held.id);
      let typeResume: string | null = null;
      if (!held && node.claude) {
        // The host (and the shell) are gone — a reboot. The conversation is not. A claude
        // profile takes --resume in its own args; but claude typed into a plain shell must be
        // resumed by TYPING again — appending --resume to pwsh.exe made every restored pane
        // error out (found the morning after v0.10.0).
        const runsClaude = `${effective.exe} ${effective.args.join(" ")}`.toLowerCase().includes("claude");
        if (runsClaude) {
          const args: string[] = [];
          for (let i = 0; i < effective.args.length; i++) {
            if (effective.args[i] === "--session-id") { i++; continue; }
            args.push(effective.args[i]!);
          }
          effective = { ...effective, args: [...args, "--resume", node.claude] };
        } else {
          typeResume = node.claude;
        }
      }
      const pane = new Pane(this, effective, node.cwd ?? null);
      pane.typeResume = typeResume;
      pane.claudeSessionId = node.claude ?? null;
      if (held && held.exited === null) {
        pane.attachTo = held.id;
        pane.claudeSessionId = held.claude_session_id ?? pane.claudeSessionId;
      }
      return pane;
    }
    const missing = hostId
      ? `[the SSH host "${hostId}" this pane used no longer exists]`
      : `[the profile "${wanted}" this pane used no longer exists]`;
    const pane = new Pane(this, { id: wanted, name: hostId ?? wanted, exe: "", args: [], cwd: null, env: {} }, node.cwd ?? null);
    pane.deadReason = missing;
    return pane;
  }

  private async restoreTab(saved: SavedTab, asleep = false): Promise<boolean> {
    const build = (n: L.SavedNode): L.Node | null => {
      if (n.kind === "leaf") {
        return L.leaf(this.restorePane(n, saved));
      }
      const a = n.a && build(n.a);
      const b = n.b && build(n.b);
      if (!a || !b) return a ?? b ?? null;
      return { kind: "split", dir: n.dir ?? "row", ratio: n.ratio ?? 0.5, a, b };
    };
    const root = build(saved.root);
    if (!root) return false;
    const el = document.createElement("div");
    el.className = "tab-panes";
    this.panesEl.appendChild(el);
    const list = L.panes(root);
    const tab: Tab = {
      id: nextTabId++,
      root,
      active: list[0]!,
      el,
      projectId: this.project(saved.project) ? saved.project : null,
      color: saved.color,
      name: saved.name ?? null,
      accountId: saved.account ?? null,
      hostId: saved.host ?? null,
      slot: saved.slot ?? this.nextSlot(),
    };
    this.tabs.push(tab);
    this.layout(tab);
    // ConPTY spawns are independent: 24 panes should not be 24 round trips in series.
    // A capture profile has to attach: its log is written from the stream it would not receive.
    for (const p of list) if (asleep && p.attachTo !== null && !p.profile.capture) p.startAsleep = true;
    await Promise.all(list.map((p) => this.startPane(tab, p)));
    for (const p of list) {
      if (!p.typeResume || p.exited || p.id < 0) continue;
      const id = p.typeResume;
      p.typeResume = null;
      // Give the shell a moment to draw its prompt before typing into it (same as signIn).
      window.setTimeout(() => !p.exited && void this.tp.write(p.id, `claude --resume ${id}\r`).catch(() => {}), 900);
    }
    return true;
  }

  // ---- clipboard --------------------------------------------------------------------------

  async copy(): Promise<boolean> {
    const t = this.tab?.active.term.term;
    if (!t?.hasSelection()) return false;
    await this.tp.writeClipboard(t.getSelection());
    t.clearSelection();
    return true;
  }

  async paste() {
    const pane = this.tab?.active;
    const t = pane?.term.term;
    if (!pane || !t) return;
    const text = await this.tp.readClipboard().catch(() => "");
    if (text) return t.paste(text);
    // No text: a screenshot, maybe. Save it and type its path — the fastest way to put an
    // image in front of a Claude prompt on Windows.
    const path = await this.tp.readClipboardImage().catch(() => null);
    if (path) t.paste(`"${path}" `);
  }
}
