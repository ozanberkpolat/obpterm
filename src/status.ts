// The bottom bar: which account new shells get, what this machine has spent lately, and where
// the focused pane is running. Usage comes from Claude Code's transcripts on disk — it is what
// obpterm can see locally, not Anthropic's own accounting of the plan window.
import type { App } from "./app";
import { openMenu } from "./menu";
import type { Account, ClaudeAccount, ClaudeLimits, ClaudeUsage, HostMetrics, ReleaseInfo } from "./transport";
import { toast } from "./ui";

const REFRESH_MS = 60_000;
/** Five seconds: the sample is a CPU counter plus memory, cheap, but it is a timer on the UI
 *  thread of a window whose whole problem is a saturated machine. Three was more than the eye
 *  reads off a bar. */
const METRICS_MS = 5_000;

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

  private version = "";

  constructor(private app: App) {
    void this.app.tp.appVersion().then((v) => {
      this.version = v;
      if (!this.pendingUpdate) {
        this.updateEl.textContent = `v${v}`;
        this.updateEl.title = "Click to check GitHub for a newer release (it also checks by itself once a day)";
      }
    });
    document.querySelector("#account-chip")!.addEventListener("click", (e) => this.accountMenu(e as MouseEvent));
    document.querySelector("#target-chip")!.addEventListener("click", (e) => this.hostMenu(e as MouseEvent));
    this.quota.addEventListener("click", (e) => this.usageMenu(e as MouseEvent));
    this.updateEl.addEventListener("click", () => void this.checkUpdates());
    this.hostEl.addEventListener("click", (e) => this.hostMenu2(e as MouseEvent));
    // The one chip that names a problem should also fix it: it only shows when the focused
    // conversation is filling up, and the fix is always the same word.
    document.querySelector("#ctx-chip")!.addEventListener("click", () => {
      const pane = this.app.tab?.active;
      if (pane) this.app.compact(pane);
    });
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

  /** How full the machine's RAM is, 0-100, or null before the first sample. What the eco sweep
   *  watches: an out-of-memory machine thrashes on swap and every window stalls with it. */
  memoryPct(): number | null {
    const m = this.metrics;
    if (!m || !m.mem_total) return null;
    return (m.mem_used / m.mem_total) * 100;
  }

  /** The fuller of RAM and commit charge, 0-100. Commit is what the OS actually runs out of:
   *  physical RAM at 80% with the pagefile filling is a machine a minute from swap thrash, and
   *  the RAM gauge alone said "fine". Null before the first sample. */
  pressurePct(): number | null {
    const m = this.metrics;
    if (!m) return null;
    const ram = m.mem_total ? (m.mem_used / m.mem_total) * 100 : 0;
    const commit = m.commit_total ? (m.commit_used / m.commit_total) * 100 : 0;
    return Math.max(ram, commit);
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
    this.metricsAt = Date.now();
    this.paintMetrics();
    // The sample is what the pressure sweep decides on; running it here, on every sample, is
    // what lets it act within seconds of a fan-out instead of at the next minute mark.
    this.app.pressureSweep();
  }

  /** When the numbers on the bar were actually taken. */
  private metricsAt = 0;

  /** The four gauge elements, built once and patched: rebuilding them from innerHTML on every
   *  sample was a DOM churn twenty times a minute for numbers that mostly had not changed. */
  private gaugeEls = new Map<string, { el: HTMLElement; bar: HTMLElement; v: HTMLElement }>();

  private paintMetrics() {
    const m = this.metrics;
    if (!m) {
      this.metricsEl.replaceChildren();
      this.gaugeEls.clear();
      return;
    }
    // Commit charge takes the swap slot when the OS reports it: RAM plus pagefile in use is the
    // number that predicts a swap thrash, and it is what the eco sweep watches too.
    const commit = m.commit_total > 0;
    const gauges: [string, number, string][] = [
      ["cpu", m.cpu / 100, `${Math.round(m.cpu)}%`],
      ["ram", share(m.mem_used, m.mem_total), `${gb(m.mem_used)}/${gb(m.mem_total)}`],
      commit
        ? ["commit", share(m.commit_used, m.commit_total), `${gb(m.commit_used)}/${gb(m.commit_total)} — RAM + pagefile in use`]
        : ["swap", share(m.swap_used, m.swap_total), m.swap_total ? `${gb(m.swap_used)}/${gb(m.swap_total)}` : "none"],
      ["disk", share(m.disk_used, m.disk_total), `${gb(m.disk_used)}/${gb(m.disk_total)}`],
    ];
    // A window starved of memory stops running its timers, so the last sample it managed to
    // take — one from the moment everything was pegged — stays on the bar for as long as the
    // freeze lasts. That is why the meter reads 100% long after the machine has recovered.
    // Say the number is old rather than letting it pretend to be current.
    const age = Date.now() - this.metricsAt;
    const stale = age > 10_000;
    this.metricsEl.classList.toggle("stale", stale);
    this.metricsEl.title = stale ? `Last read ${Math.round(age / 1000)}s ago — the window was busy` : "";
    const wanted = gauges.map(([label]) => label).join(",");
    if (this.metricsEl.dataset.gauges !== wanted) {
      this.metricsEl.dataset.gauges = wanted;
      this.gaugeEls.clear();
      this.metricsEl.replaceChildren(
        ...gauges.map(([label]) => {
          const el = document.createElement("span");
          el.className = "gauge";
          el.dataset.metric = label;
          el.innerHTML = `<span class="k">${label}</span><span class="bar"><i></i></span><span class="v"></span>`;
          this.gaugeEls.set(label, { el, bar: el.querySelector<HTMLElement>("i")!, v: el.querySelector<HTMLElement>(".v")! });
          return el;
        }),
      );
    }
    for (const [label, fraction, text] of gauges) {
      const g = this.gaugeEls.get(label)!;
      g.el.classList.toggle("full", fraction >= 0.9);
      g.el.classList.toggle("high", fraction >= 0.75 && fraction < 0.9);
      const title = `${label.toUpperCase()} ${text}${label === "disk" && m.disk_name ? ` on ${m.disk_name}` : ""}`;
      if (g.el.title !== title) g.el.title = title;
      const width = `${Math.round(Math.min(1, fraction) * 100)}%`;
      if (g.bar.style.width !== width) g.bar.style.width = width;
      const value = label === "cpu" ? text : width;
      if (g.v.textContent !== value) g.v.textContent = value;
    }
  }

  /**
   * Asks GitHub for the newest release. Both the query and the download happen in Rust: the
   * webview cannot fetch a release asset, because GitHub redirects it to a host that sends no
   * CORS headers, and the fetch fails with a bare "Failed to fetch".
   */
  /** `quiet` is the daily self-check: no toasts, no "Checking…" flicker — the chip only
   *  changes when there is actually something to install. */
  async checkUpdates(quiet = false) {
    if (this.pendingUpdate) return void this.install();
    const repo = this.app.config.update_repo;
    if (!repo) return quiet ? undefined : toast("Set update_repo in config.json to check for updates");
    if (!quiet) {
      this.updateEl.textContent = "Checking…";
      this.updateEl.disabled = true;
    }
    try {
      // Belt to the timeout's braces: whatever happens down there, this chip comes back.
      const release = await Promise.race([
        this.app.tp.updateCheck(repo, this.app.config.github_token),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer from GitHub in 30s")), 30_000)),
      ]);
      if (!release.newer) {
        this.updateEl.textContent = `v${this.version}`;
        this.updateEl.title = `v${this.version} is the newest release (checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}) — click to check again`;
        return;
      }
      this.pendingUpdate = release;
      this.updateEl.classList.add("has-update");
      this.updateEl.textContent = `Update to ${release.version}`;
      this.updateEl.title = `Installs ${release.name} and restarts OBPTerm — your shells keep running in the host`;
    } catch (e) {
      if (!quiet) {
        this.updateEl.textContent = `v${this.version}`;
        toast(`Update check failed: ${e}`);
      }
    } finally {
      this.updateEl.disabled = false;
    }
  }

  private async install() {
    const update = this.pendingUpdate!;
    this.updateEl.disabled = true;
    this.updateEl.textContent = `Downloading ${update.version}…`;
    try {
      // Write the session with the CURRENT host id last thing before the installer runs: the
      // next window matches against it, and a stale one is what makes ten sessions respawn.
      await this.app.connectHost();
      await this.app.flushSession();
      await this.app.tp.updateInstall(update, this.app.config.github_token);
      this.updateEl.textContent = "Installing, OBPTerm will restart…";
    } catch (e) {
      this.updateEl.disabled = false;
      this.updateEl.textContent = `Update to ${update.version}`;
      toast(`Update failed: ${e}`);
    }
  }

  /** The focused pane's context fill, next to the quota meters — the third gauge that
   *  matters while an agent runs. */
  paintCtx() {
    const el = document.querySelector<HTMLElement>("#ctx-chip")!;
    const pct = this.app.tab?.active.ctxPct ?? null;
    el.hidden = pct === null;
    if (pct === null) return;
    el.querySelector<HTMLElement>(".bar i")!.style.width = `${pct}%`;
    el.querySelector<HTMLElement>(".v")!.textContent = `ctx ${pct}%`;
    el.classList.toggle("high", pct >= 70 && pct < 85);
    el.classList.toggle("full", pct >= 85);
    el.title = `This session's context window is ${pct}% full — at 100% Claude compacts it and loses detail`;
  }

  paint() {
    this.paintCtx();
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
    const idle = this.app.fleet().idleRss;
    openMenu(e.clientX, e.clientY, [
      { label: "Wake every sleeping tab", onPick: () => void this.app.wakeAll() },
      {
        label: "Sleep every idle session",
        hint: idle >= 1e8 ? `frees ~${(idle / 1e9).toFixed(1)} GB` : "each resumes on click",
        onPick: () => this.app.sleepIdle(),
      },
      // One row per background shell — everything about it is already in `held`, and a stray
      // debug shell should not force adopting or killing the two sessions you actually want
      // back. The bulk actions stay underneath for when all of them are the same decision.
      ...this.app.orphanRows(),
      ...(this.app.orphanedSessions() > 1
        ? [
            {
              label: `Open all ${this.app.orphanedSessions()} as tabs`,
              hint: "keeps them running",
              onPick: () => void this.app.adoptOrphans(),
            },
            {
              label: `End all ${this.app.orphanedSessions()}`,
              hint: "~400 MB each",
              danger: true,
              onPick: () => void this.app.killOrphans(),
            },
          ]
        : []),
      {
        label: "Restart the session host",
        hint: this.app.hostVersion ? `now ${this.app.hostVersion}` : "",
        onPick: () => void this.app.restartHost(),
      },
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
    // Never silence. Usage is read off disk a moment after launch, and a chip that does nothing
    // while you wait for that is indistinguishable from a broken one.
    if (!u) {
      return openMenu(e.clientX, e.clientY, [
        {
          label: this.version ? "Reading this account's usage…" : "Starting up…",
          hint: "transcripts on this machine",
          onPick: () => void this.refresh(),
        },
      ]);
    }
    // Defensive on purpose: this menu is built from a file on disk, and a reading that is
    // partial, from an older Claude Code, or half-written must not throw — a handler that
    // throws opens nothing at all, which is a chip that looks broken.
    const line = (label: string, b: typeof u.window_5h | undefined) =>
      b ? `${label}: ${fmt(b.billed)} billed · ${fmt(b.cache_read)} cached · ${b.messages} messages` : `${label}: nothing recorded`;
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
      ...(u.by_project ?? []).map(([name, billed]) => ({
        label: `    ${name}: ${fmt(billed)} billed (7d)`,
        onPick: () => {},
      })),
      {
        label: `From ${u.files_scanned ?? 0} transcripts in ${u.dir ?? "this account"}`,
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
