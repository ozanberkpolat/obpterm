// One pane = one pty + one xterm. Panes own their DOM node and keep it across re-layouts,
// so splitting or moving a pane never loses scrollback.
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
  onPaneTitle(pane: Pane): void;
  onPaneExit(pane: Pane, code: number | null): void;
  onPaneFocus(pane: Pane): void;
  /** A drag left a selection and copy-on-select is on. */
  onPaneSelection(text: string): void;
}

export class Pane {
  readonly el = document.createElement("div");
  readonly term: Term;
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
  /** Set once the "[exited with code N]" line is on screen: the next keypress closes the pane. */
  exitAcknowledged = false;
  /** Non-null when this pane must not spawn anything — a restored tab whose target is gone. */
  deadReason: string | null = null;
  logPath: string | null = null;

  constructor(
    public host: PaneHost,
    public profile: Profile,
    cwd: string | null = null,
  ) {
    this.cwd = cwd ?? profile.cwd ?? null;
    this.title = profile.name;
    this.el.className = "pane";
    this.term = createTerm(this.el, host.config);
    const t = this.term.term;

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
    // OSC 9;9;<path> — the shell reporting its working directory (Windows Terminal's convention).
    t.parser.registerOscHandler(9, (payload) => {
      if (payload.startsWith("9;")) {
        this.cwd = payload.slice(2).replace(/^"|"$/g, "") || this.cwd;
        host.onPaneTitle(this);
      }
      return false; // let xterm's own OSC 9 (notifications) still see it
    });
    t.onData((d) => {
      if (this.exited) return host.onPaneExit(this, 0); // any key closes an exited pane
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
    new ResizeObserver(() => this.term.fit()).observe(this.el);
  }

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
    this.id = await this.host.tp.spawn(
      { ...this.profile, cwd: this.cwd },
      t.cols,
      t.rows,
      (bytes) => {
        const wasIdle = Date.now() - this.lastOutput > ACTIVE_MS;
        this.lastOutput = Date.now();
        if (wasIdle) this.host.onPaneActivity();
        t.write(bytes);
      },
      (code) => {
        this.exited = true;
        this.host.onPaneExit(this, code);
      },
    );
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
