// The bottom bar: which account new shells get, what this machine has spent lately, and where
// the focused pane is running. Usage comes from Claude Code's transcripts on disk — it is what
// obpterm can see locally, not Anthropic's own accounting of the plan window.
import type { App } from "./app";
import { openMenu } from "./menu";
import type { Account, ClaudeAccount, ClaudeLimits, ClaudeUsage, HostMetrics, ReleaseInfo } from "./transport";
import { toast } from "./ui";

const REFRESH_MS = 60_000;
const METRICS_MS = 3_000;

export class Status {
  private who = document.querySelector<HTMLElement>("#account-chip .who")!;
  private dot = document.querySelector<HTMLElement>("#account-chip .dot")!;
  private quota = document.querySelector<HTMLElement>("#quota")!;
  private target = document.querySelector<HTMLElement>("#target-chip .where")!;
  private cwd = document.querySelector<HTMLElement>("#cwd")!;
  private capture = document.querySelector<HTMLElement>("#capture")!;
  private panecount = document.querySelector<HTMLElement>("#panecount")!;
  private metricsEl = document.querySelector<HTMLElement>("#metrics")!;
  private updateEl = document.querySelector<HTMLButtonElement>("#update-chip")!;
  private hostEl = document.querySelector<HTMLButtonElement>("#host-chip")!;
  private login: ClaudeAccount | null = null;
  /** Logins Claude Code itself keeps in the current account's config dir. */
  private logins: string[] = [];
  private metrics: HostMetrics | null = null;
  private pendingUpdate: ReleaseInfo | null = null;
  private usage: ClaudeUsage | null = null;
  private limits: ClaudeLimits | null = null;
  private lastDir: string | null = null;

  constructor(private app: App) {
    document.querySelector("#account-chip")!.addEventListener("click", (e) => this.accountMenu(e as MouseEvent));
    document.querySelector("#target-chip")!.addEventListener("click", (e) => this.hostMenu(e as MouseEvent));
    this.quota.addEventListener("click", (e) => this.usageMenu(e as MouseEvent));
    this.updateEl.addEventListener("click", () => void this.checkUpdates());
    this.hostEl.addEventListener("click", (e) => this.hostMenu2(e as MouseEvent));
    this.capture.addEventListener("click", () => {
      const path = this.app.tab?.active.logPath;
      if (!path) return;
      void this.app.tp.writeClipboard(path).then(() => toast(`Copied ${path}`)).catch(() => {});
    });
    window.addEventListener("focus", () => void this.refresh());
    window.setInterval(() => void this.refresh(), REFRESH_MS);
    window.setInterval(() => void this.refreshMetrics(), METRICS_MS);
    void this.refresh();
    void this.refreshMetrics();
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
      this.logins = [];
      this.usage = null;
      this.lastDir = null;
      return this.paint();
    }
    try {
      const fresh = dir !== this.lastDir;
      this.lastDir = dir;
      if (fresh) {
        this.login = await this.app.tp.claudeAccount(dir);
        this.logins = await this.app.tp.claudeAccountNames(dir).catch(() => []);
      }
      this.usage = await this.app.tp.claudeUsage(dir);
      // Anthropic's own percentages when they are reachable; the local sum stays the fallback.
      this.limits = await this.app.tp
        .claudeLimits(this.app.config.limits_file, this.app.config.limits_url)
        .catch(() => null);
    } catch (e) {
      console.warn("usage unavailable", e);
    }
    this.paint();
  }

  async refreshMetrics() {
    this.metrics = await this.app.tp.hostMetrics(this.app.tab?.active.cwd ?? null).catch(() => null);
    this.paintMetrics();
  }

  private paintMetrics() {
    const m = this.metrics;
    if (!m) {
      this.metricsEl.replaceChildren();
      return;
    }
    const gauges: [string, number, string][] = [
      ["cpu", m.cpu / 100, `${Math.round(m.cpu)}%`],
      ["ram", share(m.mem_used, m.mem_total), `${gb(m.mem_used)}/${gb(m.mem_total)}`],
      ["swap", share(m.swap_used, m.swap_total), m.swap_total ? `${gb(m.swap_used)}/${gb(m.swap_total)}` : "none"],
      ["disk", share(m.disk_used, m.disk_total), `${gb(m.disk_used)}/${gb(m.disk_total)}`],
    ];
    this.metricsEl.replaceChildren(
      ...gauges.map(([label, fraction, text]) => {
        const el = document.createElement("span");
        el.className = "gauge" + (fraction >= 0.9 ? " full" : fraction >= 0.75 ? " high" : "");
        el.dataset.metric = label;
        el.title = `${label.toUpperCase()} ${text}${label === "disk" && m.disk_name ? ` on ${m.disk_name}` : ""}`;
        el.innerHTML = `<span class="k">${label}</span><span class="bar"><i></i></span><span class="v"></span>`;
        el.querySelector<HTMLElement>("i")!.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
        el.querySelector<HTMLElement>(".v")!.textContent =
          label === "cpu" ? text : `${Math.round(Math.min(1, fraction) * 100)}%`;
        return el;
      }),
    );
  }

  /**
   * Asks GitHub for the newest release. Both the query and the download happen in Rust: the
   * webview cannot fetch a release asset, because GitHub redirects it to a host that sends no
   * CORS headers, and the fetch fails with a bare "Failed to fetch".
   */
  async checkUpdates() {
    if (this.pendingUpdate) return void this.install();
    const repo = this.app.config.update_repo;
    if (!repo) return toast("Set update_repo in config.json to check for updates");
    this.updateEl.textContent = "Checking…";
    this.updateEl.disabled = true;
    try {
      const release = await this.app.tp.updateCheck(repo, this.app.config.github_token);
      if (!release.newer) {
        this.updateEl.textContent = "App is up to date";
        this.updateEl.title = `${await this.app.tp.appVersion()} is the newest release`;
        return;
      }
      this.pendingUpdate = release;
      this.updateEl.classList.add("has-update");
      this.updateEl.textContent = `Update to ${release.version}`;
      this.updateEl.title = `Installs ${release.name} and restarts OBPTerm with your tabs`;
    } catch (e) {
      this.updateEl.textContent = "Check for updates";
      toast(`Update check failed: ${e}`);
    } finally {
      this.updateEl.disabled = false;
    }
  }

  private async install() {
    const update = this.pendingUpdate!;
    this.updateEl.disabled = true;
    this.updateEl.textContent = `Downloading ${update.version}…`;
    try {
      await this.app.flushSession();
      await this.app.tp.updateInstall(update, this.app.config.github_token);
      this.updateEl.textContent = "Installing, OBPTerm will restart…";
    } catch (e) {
      this.updateEl.disabled = false;
      this.updateEl.textContent = `Update to ${update.version}`;
      toast(`Update failed: ${e}`);
    }
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
            this.login?.name ? `Claude Code login: ${this.login.name}` : null,
            Object.entries(account.env).map(([k, v]) => `${k}=${v}`).join("\n") || "no extra environment",
            "Click to open a tab under another account.",
          ]
            .filter(Boolean)
            .join("\n")
        : "Add accounts to config.json to switch between Claude Code logins or cloud CLIs",
    );

    if (this.limits) {
      this.realMeter("5h", this.limits.five_hour, this.limits.five_hour_resets_at);
      this.realMeter("7d", this.limits.weekly, this.limits.weekly_resets_at);
    } else {
      this.meter("5h", this.usage?.window_5h.billed ?? null, this.app.config.quota_5h_tokens);
      this.meter("7d", this.usage?.window_7d.billed ?? null, this.app.config.quota_7d_tokens);
    }

    const pane = tab?.active;
    const host = this.app.host(tab?.hostId ?? null);
    this.target.textContent = host ? host.name : pane?.profile.name ?? "—";
    this.cwd.textContent = pane?.cwd ?? "";
    this.capture.hidden = !pane?.logPath;
    if (pane?.logPath) this.capture.title = pane.logPath;
    const panes = tab ? this.app.paneCount(tab) : 0;
    this.panecount.textContent = panes > 1 ? `${panes} panes` : "";

    // A background process holding shells must never be invisible.
    const sleeping = this.app.sleepingCount();
    const orphans = this.app.orphanedSessions();
    const parts = [];
    if (sleeping) parts.push(`${sleeping} asleep`);
    if (orphans) parts.push(`${orphans} in the background`);
    this.hostEl.hidden = !this.app.hostInstance || parts.length === 0;
    this.hostEl.textContent = parts.join(" · ");
  }

  /** The real limit: a percentage that means something, and when it frees up. */
  private realMeter(window: "5h" | "7d", pct: number, resetsAt: number) {
    const el = this.quota.querySelector<HTMLElement>(`.meter[data-window="${window}"]`)!;
    const bar = el.querySelector<HTMLElement>("i")!;
    const share = Math.min(1, pct / 100);
    bar.style.width = `${Math.round(share * 100)}%`;
    el.classList.toggle("high", pct >= 75 && pct < 95);
    el.classList.toggle("full", pct >= 95);
    el.classList.toggle("stale", !!this.limits?.stale);
    const resets = resetsAt ? new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    el.querySelector<HTMLElement>(".val")!.textContent = `${window} ${pct}%`;
    el.title =
      `${pct}% of the ${window === "5h" ? "5-hour" : "weekly"} limit used` +
      (resets ? `, resets at ${resets}` : "") +
      `\nfrom ${this.limits?.source}${this.limits?.stale ? " (stale — no session has reported lately)" : ""}`;
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
    if (!accounts.length) return this.app.settings.open("accounts");
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
      { label: "Add a Claude Code account…", onPick: () => this.app.addClaudeAccount() },
      { label: "Manage accounts…", onPick: () => this.app.settings.open("accounts") },
      ...(this.logins.length > 1
        ? [
            {
              label: `This folder holds ${this.logins.length} logins: ${this.logins.join(", ")}`,
              hint: "use /login",
              onPick: () =>
                toast(
                  "Claude Code keeps those logins in one folder and only its own /login can switch between them. Give each account its own CLAUDE_CONFIG_DIR to switch from here.",
                ),
            },
          ]
        : []),
    ]);
  }

  private hostMenu(e: MouseEvent) {
    const hosts = this.app.config.hosts;
    if (!hosts.length) return this.app.settings.open("hosts");
    openMenu(e.clientX, e.clientY, [
      ...hosts.map((h) => ({
        label: h.name,
        hint: h.user ? `${h.user}@${h.host}` : h.host,
        onPick: () => void this.app.newTabForHost(h),
      })),
      { label: "Split with this host…", onPick: () => this.hostSplitMenu(e) },
      { label: "Manage hosts…", onPick: () => this.app.settings.open("hosts") },
    ]);
  }

  /** The session host's chip: what it holds, and the one way to end it all. */
  private hostMenu2(e: MouseEvent) {
    openMenu(e.clientX, e.clientY, [
      { label: "Wake every sleeping tab", onPick: () => void this.app.wakeAll() },
      { label: "Quit and end every shell", danger: true, onPick: () => void this.app.quitAll() },
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
    const real = this.limits
      ? [
          {
            label: `Limit: 5h ${this.limits.five_hour}% · weekly ${this.limits.weekly}%`,
            hint: this.limits.stale ? "stale" : this.limits.source,
            onPick: () => {},
          },
        ]
      : [];
    openMenu(e.clientX, e.clientY, [
      ...real,
      { label: line("Last 5h", u.window_5h), onPick: () => {} },
      { label: line("Last 7d", u.window_7d), onPick: () => {} },
      ...u.by_project.map(([name, billed]) => ({
        label: `    ${name}: ${fmt(billed)} billed (7d)`,
        onPick: () => {},
      })),
      {
        label: `From ${u.files_scanned} transcripts in ${u.dir}`,
        hint: u.last_activity ? new Date(u.last_activity).toLocaleTimeString() : "",
        onPick: () => {},
      },
      { label: "Refresh now", onPick: () => void this.refresh() },
    ]);
  }
}

function share(used: number, total: number): number {
  return total > 0 ? used / total : 0;
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${Math.round(bytes / 1024 ** 2)}M`;
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
