// Tabs + the vertical rail. One pty per tab, one xterm per tab, all tabs stay mounted
// (hidden via CSS) so scrollback and selection survive switching.
import type { Config, Profile, Transport } from "./transport";
import { createTerm, applyTermConfig, type Term } from "./term";
import { ownsKey } from "./keys";

interface Tab {
  id: number;
  profile: Profile;
  title: string;
  el: HTMLElement;
  term: Term;
  li: HTMLLIElement;
  exited: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export class App {
  tabs: Tab[] = [];
  active: Tab | null = null;
  private panes = $("#panes");
  private list = $("#tabs");
  private rail = $("#rail");

  constructor(
    private tp: Transport,
    public config: Config,
  ) {
    this.rail.classList.toggle("collapsed", config.rail_collapsed);
    new ResizeObserver(() => this.fitActive()).observe(this.panes);
    $("#rail-toggle").onclick = () => this.toggleRail();
    $("#new-tab").onclick = () => void this.newTab();
    $("#new-tab").oncontextmenu = (e) => {
      e.preventDefault();
      this.showProfileMenu(e.clientX, e.clientY);
    };
    document.addEventListener("click", () => ($("#profile-menu").hidden = true));
  }

  // ---- tabs ---------------------------------------------------------------------------------

  profileById(id: string): Profile {
    const p = this.config.profiles.find((p) => p.id === id) ?? this.config.profiles[0];
    if (!p) throw new Error("config has no profiles");
    return p;
  }

  async newTab(profile: Profile = this.profileById(this.config.default_profile)) {
    const el = document.createElement("div");
    el.className = "pane";
    this.panes.appendChild(el);
    const term = createTerm(el, this.config);
    const li = document.createElement("li");
    const tab: Tab = { id: -1, profile, title: profile.name, el, term, li, exited: false };
    this.tabs.push(tab);
    this.activate(tab); // fit before spawn so the pty gets the real size
    term.term.attachCustomKeyEventHandler((e) => !ownsKey(e)); // our shortcuts never reach the shell
    term.term.onTitleChange((t) => {
      tab.title = t || profile.name;
      this.renderRail();
    });
    term.term.onData((d) => {
      if (tab.exited) return void this.closeTab(tab);
      void this.tp.write(tab.id, d).catch((e) => toast(String(e)));
    });
    term.term.onResize(({ cols, rows }) => {
      if (tab.id > 0 && !tab.exited) void this.tp.resize(tab.id, cols, rows).catch(() => {});
    });
    try {
      tab.id = await this.tp.spawn(
        profile,
        term.term.cols,
        term.term.rows,
        (bytes) => term.term.write(bytes),
        (code) => this.onExit(tab, code),
      );
    } catch (e) {
      this.removeTab(tab);
      toast(`Could not start ${profile.name}: ${e}`);
      return;
    }
    this.renderRail();
    term.term.focus();
  }

  private onExit(tab: Tab, code: number | null) {
    tab.exited = true;
    if (code === 0 || code === null) return this.closeTab(tab);
    tab.term.term.write(`\r\n\x1b[38;2;255;107;115m[${tab.profile.exe} exited with code ${code}]\x1b[0m press any key to close\r\n`);
    this.renderRail();
  }

  closeTab(tab: Tab) {
    if (!tab.exited && tab.id > 0) void this.tp.kill(tab.id).catch(() => {});
    this.removeTab(tab);
    if (this.tabs.length === 0) {
      if (this.tp.native) void import("@tauri-apps/api/window").then((w) => w.getCurrentWindow().close());
      else void this.newTab();
    }
  }

  private removeTab(tab: Tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.term.dispose();
    tab.el.remove();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    this.renderRail();
  }

  activate(tab: Tab) {
    this.active = tab;
    for (const t of this.tabs) t.el.classList.toggle("active", t === tab);
    this.renderRail();
    this.fitActive();
    tab.term.term.focus();
  }

  cycle(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]!);
  }

  jump(index: number) {
    const t = this.tabs[index];
    if (t) this.activate(t);
  }

  private fitActive() {
    if (!this.active) return;
    this.active.term.fit();
  }

  // ---- rail ---------------------------------------------------------------------------------

  renderRail() {
    this.list.replaceChildren();
    this.tabs.forEach((tab, i) => {
      const li = tab.li;
      li.className = "tab" + (tab === this.active ? " active" : "") + (tab.exited ? " exited" : "");
      li.title = `${tab.title}\n${tab.profile.name}`;
      li.innerHTML =
        `<span class="num">${i + 1}</span>` +
        `<span class="label"><span class="title"></span><span class="sub"></span></span>` +
        `<button class="close" title="Close (Ctrl+Shift+W)">×</button>`;
      li.querySelector(".title")!.textContent = tab.title;
      li.querySelector(".sub")!.textContent = tab.title === tab.profile.name ? "" : tab.profile.name;
      li.onclick = () => this.activate(tab);
      li.onauxclick = (e) => e.button === 1 && this.closeTab(tab);
      (li.querySelector(".close") as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        this.closeTab(tab);
      };
      this.list.appendChild(li);
    });
  }

  toggleRail() {
    this.config.rail_collapsed = this.rail.classList.toggle("collapsed");
    void this.saveConfig();
  }

  showProfileMenu(x: number, y: number) {
    const menu = $("#profile-menu");
    menu.replaceChildren(
      ...this.config.profiles.map((p, i) => {
        const b = document.createElement("button");
        b.innerHTML = `<span class="k">Ctrl+Shift+${i + 1}</span>`;
        b.prepend(document.createTextNode(p.name));
        b.onclick = () => void this.newTab(p);
        return b;
      }),
    );
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.hidden = false;
  }

  // ---- config -------------------------------------------------------------------------------

  applyConfig() {
    document.documentElement.style.setProperty("--term-bg", this.config.theme.background ?? "#0a0e14");
    document.documentElement.style.setProperty("--mono", this.config.font_family);
    for (const t of this.tabs) applyTermConfig(t.term.term, this.config);
    this.fitActive();
  }

  async saveConfig() {
    await this.tp.saveConfig(this.config).catch((e) => toast(`Config not saved: ${e}`));
  }

  zoom(delta: number) {
    this.config.font_size = delta === 0 ? 14 : Math.min(40, Math.max(8, this.config.font_size + delta));
    this.applyConfig();
    void this.saveConfig();
  }

  // ---- clipboard ----------------------------------------------------------------------------

  async copy(): Promise<boolean> {
    const t = this.active?.term.term;
    if (!t?.hasSelection()) return false;
    await this.tp.writeClipboard(t.getSelection());
    t.clearSelection();
    return true;
  }

  async paste() {
    const t = this.active?.term.term;
    if (!t) return;
    const text = await this.tp.readClipboard().catch(() => "");
    if (text) t.paste(text);
  }
}

let toastTimer = 0;
export function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}
