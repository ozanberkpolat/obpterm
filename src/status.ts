// The bottom bar: which account new shells get, what this machine has spent lately, and where
// the focused pane is running. Usage comes from Claude Code's transcripts on disk — it is what
// obpterm can see locally, not Anthropic's own accounting of the plan window.
import type { App } from "./app";
import { openMenu } from "./menu";
import type { Account, ClaudeAccount, ClaudeUsage, HostMetrics } from "./transport";
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
  private login: ClaudeAccount | null = null;
  private metrics: HostMetrics | null = null;
  private pendingUpdate: { version: string; name: string; url: string } | null = null;
  private usage: ClaudeUsage | null = null;
  private lastDir: string | null = null;

  constructor(private app: App) {
    document.querySelector("#account-chip")!.addEventListener("click", (e) => this.accountMenu(e as MouseEvent));
    document.querySelector("#target-chip")!.addEventListener("click", (e) => this.hostMenu(e as MouseEvent));
    this.quota.addEventListener("click", (e) => this.usageMenu(e as MouseEvent));
    this.updateEl.addEventListener("click", () => void this.checkUpdates());
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
   * Asks GitHub for the newest release. The repo is private, so `github_token` from config.json
   * is sent when it is there; a public repo needs nothing.
   */
  async checkUpdates() {
    if (this.pendingUpdate) return void this.install();
    const repo = this.app.config.update_repo;
    if (!repo) return toast("Set update_repo in config.json to check for updates");
    this.updateEl.textContent = "Checking…";
    this.updateEl.disabled = true;
    try {
      const current = await this.app.tp.appVersion();
      const release = await this.fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      const latest = String(release.tag_name ?? "").replace(/^v/, "");
      const asset = (release.assets ?? []).find((a: { name: string }) => a.name.endsWith("-setup.exe"));
      if (!latest || !asset) throw new Error("that release has no installer attached");
      if (compareVersions(latest, current) <= 0) {
        this.updateEl.textContent = "App is up to date";
        this.updateEl.title = `${current} is the newest release`;
        return;
      }
      this.pendingUpdate = { version: latest, name: asset.name, url: asset.url };
      this.updateEl.classList.add("has-update");
      this.updateEl.textContent = `Update to ${latest}`;
      this.updateEl.title = `Downloads and runs ${asset.name}, then closes OBPTerm`;
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
      // The asset API URL needs the octet-stream Accept header to return the file itself.
      const res = await fetch(update.url, { headers: { ...this.ghHeaders(), Accept: "application/octet-stream" } });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await this.app.flushSession();
      this.updateEl.textContent = "Starting installer…";
      await this.app.tp.runInstaller(update.name, bytes);
    } catch (e) {
      this.updateEl.disabled = false;
      this.updateEl.textContent = `Update to ${update.version}`;
      toast(`Update failed: ${e}`);
    }
  }

  private ghHeaders(): Record<string, string> {
    const token = this.app.config.github_token;
    return {
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async fetchJson(url: string) {
    const res = await fetch(url, { headers: { ...this.ghHeaders(), Accept: "application/vnd.github+json" } });
    if (res.status === 404) {
      throw new Error("release not found — a private repo needs github_token in config.json");
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    return res.json();
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
      { label: "Manage accounts…", onPick: () => this.app.settings.open("accounts") },
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

function share(used: number, total: number): number {
  return total > 0 ? used / total : 0;
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${Math.round(bytes / 1024 ** 2)}M`;
}

/** Plain numeric compare of dotted versions; suffixes like "-beta" sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
