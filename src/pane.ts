// One pane = one pty + one xterm. Panes own their DOM node and keep it across re-layouts,
// so splitting or moving a pane never loses scrollback.
import { blank, type AgentState } from "./agent";
import { createTerm, type Term } from "./term";
import { ownsKey } from "./keys";
import type { Config, Profile, Transport } from "./transport";

/** How recently a pane must have printed to count as running. */
export const ACTIVE_MS = 2000;

export interface PaneHost {
  tp: Transport;
  config: Config;
  /** True when this pane is the one the user is looking at. */
  isFocused(pane: Pane): boolean;
  /** A pane started or stopped producing output, or rang. */
  onPaneActivity(): void;
  /** `r` on a dead pane: run its shell again in the same terminal. */
  onPaneRespawn(pane: Pane): void;
  /** The program in this pane asked for the user's attention by name. */
  onPaneNotify(pane: Pane, title: string, body: string): void;
  /** This pane picked up a shell that survived the previous window. */
  onPaneReattached(pane: Pane): void;
  onPaneTitle(pane: Pane): void;
  onPaneExit(pane: Pane, code: number | null): void;
  onPaneFocus(pane: Pane): void;
  /** A drag left a selection and copy-on-select is on. */
  onPaneSelection(text: string): void;
}

export class Pane {
  readonly el = document.createElement("div");
  term: Term;
  /** Asleep: the terminal is gone and the host is holding the shell unwatched. */
  asleep = false;
  /** What the host last said about this shell while it was asleep. */
  heldState: { last_output: number; bell: boolean; exited: number | null } | null = null;
  /** pty id, -1 until `start()` resolves */
  id = -1;
  /** Reported by the shell via OSC 9;9; what a saved layout reopens in. */
  cwd: string | null;
  title: string;
  exited = false;
  /** Epoch ms of the last byte out of the shell — "running" is simply this being recent. */
  lastOutput = 0;
  /** A bell rang while this pane was not the one you were looking at. */
  bell = false;
  /** Non-zero exit code, kept so the rail can say so. */
  exitCode: number | null = null;
  /** 0-100 while a program reports progress over OSC 9;4, else null. */
  progress: number | null = null;
  /** Set while this pane has been busy long enough for going quiet to mean "finished". */
  busySince = 0;
  /** Set once the "[exited with code N]" line is on screen: the next keypress closes the pane. */
  exitAcknowledged = false;
  /** Non-null when this pane must not spawn anything — a restored tab whose target is gone. */
  deadReason: string | null = null;
  /** A shell the host is already holding: `start()` attaches to it instead of spawning. */
  attachTo: number | null = null;
  /** What the Claude session in this pane is doing, from its own hooks. */
  agent: AgentState = blank();
  /** Claude's session id — what `--resume` needs after a reboot or an eco sleep. */
  claudeSessionId: string | null = null;
  /** The shell was `/exit`ed on purpose to free the agent's memory; wake resumes it. */
  eco = false;
  logPath: string | null = null;

  constructor(
    public host: PaneHost,
    public profile: Profile,
    cwd: string | null = null,
  ) {
    this.cwd = cwd ?? profile.cwd ?? null;
    this.title = profile.name;
    this.el.className = "pane";
    this.term = this.buildTerm();
    new ResizeObserver(() => !this.asleep && this.term.fit()).observe(this.el);
  }

  /** The xterm and everything wired to it. Done once at construction, and again on wake. */
  private buildTerm(): Term {
    const host = this.host;
    const term = createTerm(this.el, host.config);
    const t = term.term;

    t.attachCustomKeyEventHandler((e) => !ownsKey(e)); // app shortcuts never reach the shell
    // Claude Code rings the bell when it wants you — but only with preferredNotifChannel set
    // to terminal_bell. A bell you are already looking at is not news.
    t.onBell(() => {
      if (!host.isFocused(this)) {
        this.bell = true;
        host.onPaneActivity();
      }
    });
    t.onTitleChange((title) => {
      this.title = title || this.profile.name;
      host.onPaneTitle(this);
    });
    // OSC 9 carries three different things and we were throwing two of them away:
    //   9;9;<path>  the shell reporting its directory (Windows Terminal's convention)
    //   9;4;<st>;<pct>  progress (ConEmu's; Claude Code emits it) — never a notification
    //   9;<text>    a desktop notification, which is how Claude Code says it wants you
    t.parser.registerOscHandler(9, (payload) => {
      if (payload.startsWith("9;")) {
        this.cwd = payload.slice(2).replace(/^"|"$/g, "") || this.cwd;
        host.onPaneTitle(this);
        return false;
      }
      if (payload.startsWith("4;")) {
        const [, state, pct] = payload.split(";");
        this.progress = state === "0" ? null : Number(pct ?? 0);
        host.onPaneActivity();
        return false;
      }
      host.onPaneNotify(this, this.title, payload);
      return false;
    });
    // OSC 777;notify;<title>;<body> — the same thing in urxvt's spelling.
    t.parser.registerOscHandler(777, (payload) => {
      const [kind, title, ...rest] = payload.split(";");
      if (kind === "notify") host.onPaneNotify(this, title || this.title, rest.join(";"));
      return false;
    });
    t.onData((d) => {
      if (this.exited) {
        if (d === "r" || d === "R") return host.onPaneRespawn(this);
        return host.onPaneExit(this, 0); // any other key closes an exited pane
      }
      void host.tp.write(this.id, d).catch(() => {});
    });
    t.onResize(({ cols, rows }) => {
      if (this.id > 0 && !this.exited) void host.tp.resize(this.id, cols, rows).catch(() => {});
    });
    this.el.addEventListener("mousedown", () => host.onPaneFocus(this), true);


    // A left drag always selects, even while the program has mouse reporting on — without
    // this, dragging inside Claude Code or vim never leaves a selection to copy.
    const selection = (t as unknown as { _core?: { _selectionService?: { shouldForceSelection?(e: MouseEvent): boolean } } })._core
      ?._selectionService;
    if (selection?.shouldForceSelection) {
      const original = selection.shouldForceSelection.bind(selection);
      selection.shouldForceSelection = (e: MouseEvent) => (e && e.button === 0 ? true : original(e));
    }

    // Copy-on-select: finishing a drag puts the selection on the clipboard, no keypress.
    this.el.addEventListener("mouseup", (e) => {
      if (e.button !== 0 || !host.config.copy_on_select) return;
      const text = t.getSelection();
      if (text.trim()) void host.onPaneSelection(text);
    });
      return term;
  }

  /** Tears the terminal down and stops watching the shell. The shell keeps running in the
   *  host; a click on the tab brings the terminal back with the shell's recent output. */
  async sleep() {
    if (this.asleep || this.exited || this.id < 0) return;
    this.asleep = true;
    await this.host.tp.detach(this.id).catch(() => {});
    this.term.dispose();
    this.el.replaceChildren();
    const note = document.createElement("div");
    note.className = "asleep";
    note.textContent = "asleep — click to wake";
    this.el.appendChild(note);
  }

  async wake() {
    if (!this.asleep) return;
    this.asleep = false;
    this.heldState = null;
    this.el.replaceChildren();
    this.term = this.buildTerm();
    const t = this.term.term;
    this.term.fit();
    const onData = (bytes: Uint8Array) => {
      this.lastOutput = Date.now();
      t.write(bytes);
    };
    const onExit = (code: number | null) => {
      this.exited = true;
      this.host.onPaneExit(this, code);
    };
    await this.host.tp.attach(this.id, t.cols, t.rows, onData, onExit);
    t.focus();
  }

  /** Epoch ms of the last time this pane was the one on screen. */
  lastVisited = Date.now();

  async start() {
    const t = this.term.term;
    this.lastOutput = Date.now();
    if (this.deadReason) {
      // Never substitute a different shell for a missing one: a tab that was the VPS must not
      // come back as a local PowerShell that still calls itself the VPS.
      this.exited = true;
      this.exitAcknowledged = true;
      t.write(`\r\n\x1b[38;2;255;180;84m${this.deadReason}\x1b[0m\r\n\r\n  Close this pane, or fix it in Settings and open a new tab.\r\n`);
      return;
    }
    const onData = (bytes: Uint8Array) => {
      const wasIdle = Date.now() - this.lastOutput > ACTIVE_MS;
      this.lastOutput = Date.now();
      if (wasIdle) {
        this.busySince = Date.now();
        this.host.onPaneActivity();
      }
      t.write(bytes);
    };
    const onExit = (code: number | null) => {
      this.exited = true;
      this.host.onPaneExit(this, code);
    };
    if (this.attachTo !== null) {
      // The shell never stopped; the window did. Replay its history, then go live.
      const id = this.attachTo;
      this.attachTo = null;
      await this.host.tp.attach(id, t.cols, t.rows, onData, onExit);
      this.id = id;
      this.host.onPaneReattached(this);
    } else {
      this.id = await this.host.tp.spawn({ ...this.profile, cwd: this.cwd }, t.cols, t.rows, onData, onExit);
    }
    if (this.profile.capture && !this.logPath) {
      await this.toggleLog().catch((e) => console.warn("auto-capture failed", e));
    }
  }

  async toggleLog(): Promise<string | null> {
    if (this.logPath) {
      await this.host.tp.logStop(this.id);
      this.logPath = null;
    } else {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      this.logPath = await this.host.tp.logStart(this.id, this.title || this.profile.id, stamp, this.host.config.capture_dir);
    }
    this.host.onPaneTitle(this);
    return this.logPath;
  }

  kill() {
    if (!this.exited && this.id > 0) void this.host.tp.kill(this.id).catch(() => {});
  }

  dispose() {
    this.term.dispose();
    this.el.remove();
  }

  focus() {
    this.term.fit();
    this.term.term.focus();
  }
}
