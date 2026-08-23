// The bottom bar: which account new shells get, what this machine has spent lately, and where
// the focused pane is running. Usage comes from Claude Code's transcripts on disk — it is what
// obpterm can see locally, not Anthropic's own accounting of the plan window.
import type { App } from "./app";
import { openMenu } from "./menu";
import type { Account, ClaudeAccount, ClaudeUsage } from "./transport";
import { toast } from "./ui";

const REFRESH_MS = 60_000;

export class Status {
  private who = document.querySelector<HTMLElement>("#account-chip .who")!;
  private dot = document.querySelector<HTMLElement>("#account-chip .dot")!;
  private quota = document.querySelector<HTMLElement>("#quota")!;
  private target = document.querySelector<HTMLElement>("#target-chip .where")!;
  private cwd = document.querySelector<HTMLElement>("#cwd")!;
  private capture = document.querySelector<HTMLElement>("#capture")!;
  private panecount = document.querySelector<HTMLElement>("#panecount")!;
  private login: ClaudeAccount | null = null;
  private usage: ClaudeUsage | null = null;
  private lastDir: string | null = null;

  constructor(private app: App) {
    document.querySelector("#account-chip")!.addEventListener("click", (e) => this.accountMenu(e as MouseEvent));
    document.querySelector("#target-chip")!.addEventListener("click", (e) => this.hostMenu(e as MouseEvent));
    this.quota.addEventListener("click", (e) => this.usageMenu(e as MouseEvent));
    window.addEventListener("focus", () => void this.refresh());
    window.setInterval(() => void this.refresh(), REFRESH_MS);
    void this.refresh();
  }

  /** The account new shells inherit: the focused tab's, else the configured default. */
  current(): Account | null {
    const id = this.app.tab?.accountId ?? this.app.config.default_account;
    return this.app.config.accounts.find((a) => a.id === id) ?? this.app.config.accounts[0] ?? null;
  }

  async refresh() {
    const dir = this.current()?.claude_dir ?? null;
    if (!dir) {
      this.login = null;
      this.usage = null;
      this.lastDir = null;
      return this.paint();
    }
    try {
      const fresh = dir !== this.lastDir;
      this.lastDir = dir;
      if (fresh) this.login = await this.app.tp.claudeAccount(dir);
      this.usage = await this.app.tp.claudeUsage(dir);
    } catch (e) {
      console.warn("usage unavailable", e);
    }
    this.paint();
  }

  paint() {
    const account = this.current();
    const tab = this.app.tab;
    this.dot.style.background = account?.color ?? this.app.accent();
    this.who.textContent = account
      ? this.login?.email ?? this.login?.name ?? account.name
      : "no account configured";
    document.querySelector("#account-chip")!.setAttribute(
      "title",
      account
        ? [
            `Account: ${account.name}`,
            this.login?.organization ? `Org: ${this.login.organization}` : null,
            this.login?.tier ? `Plan: ${this.login.tier}` : null,
            Object.entries(account.env).map(([k, v]) => `${k}=${v}`).join("\n") || "no extra environment",
            "Click to open a tab under another account.",
          ]
            .filter(Boolean)
            .join("\n")
        : "Add accounts to config.json to switch between Claude Code logins or cloud CLIs",
    );

    this.meter("5h", this.usage?.window_5h.billed ?? null, this.app.config.quota_5h_tokens);
    this.meter("7d", this.usage?.window_7d.billed ?? null, this.app.config.quota_7d_tokens);

    const pane = tab?.active;
    const host = this.app.host(tab?.hostId ?? null);
    this.target.textContent = host ? host.name : pane?.profile.name ?? "—";
    this.cwd.textContent = pane?.cwd ?? "";
    this.capture.hidden = !pane?.logPath;
    if (pane?.logPath) this.capture.title = pane.logPath;
    const panes = tab ? this.app.paneCount(tab) : 0;
    this.panecount.textContent = panes > 1 ? `${panes} panes` : "";
  }

  private meter(window: "5h" | "7d", tokens: number | null, budget: number | null) {
    const el = this.quota.querySelector<HTMLElement>(`.meter[data-window="${window}"]`)!;
    const bar = el.querySelector<HTMLElement>("i")!;
    const val = el.querySelector<HTMLElement>(".val")!;
    if (tokens === null) {
      val.textContent = "—";
      bar.style.width = "0%";
      el.classList.remove("full", "high");
      return;
    }
    const share = budget ? Math.min(1, tokens / budget) : 0;
    bar.style.width = `${Math.round(share * 100)}%`;
    el.classList.toggle("high", budget !== null && share >= 0.75 && share < 0.95);
    el.classList.toggle("full", budget !== null && share >= 0.95);
    val.textContent = budget ? `${window} ${Math.round(share * 100)}%` : `${window} ${fmt(tokens)}`;
    el.title = budget
      ? `${fmt(tokens)} of your ${fmt(budget)} token budget in the last ${window}`
      : `${fmt(tokens)} tokens sent in the last ${window} (set quota_${window}_tokens in config.json for a percentage)`;
  }

  private accountMenu(e: MouseEvent) {
    const accounts = this.app.config.accounts;
    if (!accounts.length) return toast("Add an account to config.json: { id, name, env, claude_dir }");
    const current = this.current();
    openMenu(e.clientX, e.clientY, [
      ...accounts.map((a) => ({
        label: `New tab as ${a.name}${a.id === current?.id ? " ✓" : ""}`,
        swatch: a.color ?? "#8b97a8",
        onPick: () => void this.app.newTab(undefined, undefined, null, a.id),
      })),
      ...accounts.map((a) => ({
        label: `Default for new tabs: ${a.name}`,
        hint: a.id === this.app.config.default_account ? "current" : "",
        onPick: () => {
          this.app.config.default_account = a.id;
          this.app.persist();
          void this.refresh();
          toast(`New tabs use ${a.name}`);
        },
      })),
    ]);
  }

  private hostMenu(e: MouseEvent) {
    const hosts = this.app.config.hosts;
    if (!hosts.length) {
      return toast("Add hosts to config.json: { id, name, host, user, port, identity }");
    }
    openMenu(e.clientX, e.clientY, [
      ...hosts.map((h) => ({
        label: h.name,
        hint: h.user ? `${h.user}@${h.host}` : h.host,
        onPick: () => void this.app.newTabForHost(h),
      })),
      { label: "Split with this host…", onPick: () => this.hostSplitMenu(e) },
    ]);
  }

  private hostSplitMenu(e: MouseEvent) {
    openMenu(
      e.clientX,
      e.clientY,
      this.app.config.hosts.map((h) => ({
        label: h.name,
        hint: "split right",
        onPick: () => void this.app.splitPane("row", this.app.hostProfile(h)),
      })),
    );
  }

  private usageMenu(e: MouseEvent) {
    const u = this.usage;
    if (!u) return toast("No Claude Code transcripts found for this account");
    const line = (label: string, b: typeof u.window_5h) =>
      `${label}: ${fmt(b.billed)} billed · ${fmt(b.cache_read)} cached · ${b.messages} messages`;
    openMenu(e.clientX, e.clientY, [
      { label: line("Last 5h", u.window_5h), onPick: () => {} },
      { label: line("Last 7d", u.window_7d), onPick: () => {} },
      {
        label: `From ${u.files_scanned} transcripts in ${u.dir}`,
        hint: u.last_activity ? new Date(u.last_activity).toLocaleTimeString() : "",
        onPick: () => {},
      },
      { label: "Refresh now", onPick: () => void this.refresh() },
    ]);
  }
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
