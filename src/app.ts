// Tabs, panes and projects. A tab owns a pane tree; a project groups tabs, gives them a colour
// and can save/restore its own set of tabs.
import { withDefaults, type Account, type Config, type Host, type Profile, type Project, type Transport } from "./transport";
import { Pane, type PaneHost } from "./pane";
import * as L from "./layout";
import { applyTermConfig } from "./term";
import { renderRail } from "./rail";
import { toast } from "./ui";
import { COLORS } from "./menu";
import type { Find } from "./find";
import type { Status } from "./status";
import type { Preset } from "./toolbar";

export interface Tab {
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
}

export interface SavedTab {
  project: string | null;
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
  private panesEl = $("#panes");
  private sessionTimer = 0;
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

  /** Environment a shell starts with: the profile's own, then the account's on top. */
  private withAccount(profile: Profile, accountId: string | null): Profile {
    const account = this.account(accountId);
    if (!account) return profile;
    return { ...profile, env: { ...(profile.env ?? {}), ...account.env } };
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
    for (const saved of tabs) await this.restoreTab({ ...saved, project: project.id });
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
    const pane = new Pane(this, this.withAccount(p, accountId), cwd ?? project?.cwd ?? this.config.default_cwd);
    const el = document.createElement("div");
    el.className = "tab-panes";
    this.panesEl.appendChild(el);
    const tab: Tab = { root: L.leaf(pane), active: pane, el, projectId, color: null, name: null, accountId, hostId: null };
    this.tabs.push(tab);
    this.activate(tab);
    await this.startPane(tab, pane);
    void this.flushSession();
    return tab;
  }

  private async startPane(tab: Tab, pane: Pane) {
    try {
      await pane.start();
    } catch (e) {
      toast(`Could not start ${pane.profile.name}: ${e}`);
      this.closePane(pane, tab);
      return;
    }
    this.paint();
  }

  closeTab(tab: Tab) {
    for (const p of L.panes(tab.root)) {
      p.kill();
      p.dispose();
    }
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
      if (this.tp.native) void import("@tauri-apps/api/window").then((w) => w.getCurrentWindow().close());
      else void this.newTab();
    }
  }

  activate(tab: Tab) {
    const accountChanged = this.tab?.accountId !== tab.accountId;
    this.tab = tab;
    if (accountChanged) void this.status?.refresh();
    for (const t of this.tabs) t.el.classList.toggle("active", t === tab);
    this.layout(tab);
    tab.active.focus();
    this.paint();
  }

  cycle(delta: number) {
    if (!this.tab || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.tab);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]!);
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
    const pane = new Pane(this, this.withAccount(profile ?? from.profile, tab.accountId), from.cwd);
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
    this.paintFocus(tab);
    this.paint();
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
      panes.push(new Pane(this, this.withAccount(from.profile, tab.accountId), from.cwd));
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

  private paintFocus(tab: Tab) {
    const many = L.panes(tab.root).length > 1;
    for (const p of L.panes(tab.root)) {
      p.el.classList.toggle("focused", many && p === tab.active);
      p.el.style.setProperty("--pane-accent", this.accent(tab));
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
    if (code === 0 || code === null || pane.exitAcknowledged) return this.closePane(pane, tab);
    // Non-zero: leave the output on screen, close on the next keypress.
    pane.exitAcknowledged = true;
    pane.term.term.write(
      `\r\n\x1b[38;2;255;107;115m[${pane.profile.exe} exited with code ${code}]\x1b[0m press any key to close\r\n`,
    );
    this.paint();
  }

  onPaneFocus(pane: Pane) {
    this.focusPane(pane);
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

  /** Repaint the rail. Cheap: the rail is the only derived view. */
  paint() {
    renderRail(this);
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
    this.applyConfig();
    this.applyRailWidth();
    document.querySelector("#rail")!.classList.toggle("collapsed", this.config.rail_collapsed);
    this.paint();
  }

  snapshot(tab: Tab): SavedTab {
    return {
      project: tab.projectId,
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
    await this.tp
      .sessionSave(this.tabs.map((t) => this.snapshot(t)))
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
  async restoreSession(): Promise<{ restored: number; crashed: boolean; updatedTo: string | null }> {
    if (!this.config.restore_session) return { restored: 0, crashed: false, updatedTo: null };
    const session = await this.tp.sessionLoad().catch(() => null);
    const saved = (session?.tabs as SavedTab[] | null) ?? [];
    let restored = 0;
    for (const tab of Array.isArray(saved) ? saved : []) {
      if (await this.restoreTab(tab)) restored++;
    }
    return {
      restored,
      crashed: restored > 0 && session?.clean_exit === false,
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
      return new Pane(this, this.withAccount(profile, saved.account ?? null), node.cwd ?? null);
    }
    const missing = hostId
      ? `[the SSH host "${hostId}" this pane used no longer exists]`
      : `[the profile "${wanted}" this pane used no longer exists]`;
    const pane = new Pane(this, { id: wanted, name: hostId ?? wanted, exe: "", args: [], cwd: null, env: {} }, node.cwd ?? null);
    pane.deadReason = missing;
    return pane;
  }

  private async restoreTab(saved: SavedTab): Promise<boolean> {
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
      root,
      active: list[0]!,
      el,
      projectId: this.project(saved.project) ? saved.project : null,
      color: saved.color,
      name: saved.name ?? null,
      accountId: saved.account ?? null,
      hostId: saved.host ?? null,
    };
    this.tabs.push(tab);
    this.activate(tab);
    for (const p of list) await this.startPane(tab, p);
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
    const t = this.tab?.active.term.term;
    if (!t) return;
    const text = await this.tp.readClipboard().catch(() => "");
    if (text) t.paste(text);
  }
}
