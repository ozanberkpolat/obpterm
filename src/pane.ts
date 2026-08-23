// One pane = one pty + one xterm. Panes own their DOM node and keep it across re-layouts,
// so splitting or moving a pane never loses scrollback.
import { createTerm, type Term } from "./term";
import { ownsKey } from "./keys";
import type { Config, Profile, Transport } from "./transport";

export interface PaneHost {
  tp: Transport;
  config: Config;
  onPaneTitle(pane: Pane): void;
  onPaneExit(pane: Pane, code: number | null): void;
  onPaneFocus(pane: Pane): void;
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
  /** Set once the "[exited with code N]" line is on screen: the next keypress closes the pane. */
  exitAcknowledged = false;
  logPath: string | null = null;

  constructor(
    private host: PaneHost,
    public profile: Profile,
    cwd: string | null = null,
  ) {
    this.cwd = cwd ?? profile.cwd ?? null;
    this.title = profile.name;
    this.el.className = "pane";
    this.term = createTerm(this.el, host.config);
    const t = this.term.term;

    t.attachCustomKeyEventHandler((e) => !ownsKey(e)); // app shortcuts never reach the shell
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
    new ResizeObserver(() => this.term.fit()).observe(this.el);
  }

  async start() {
    const t = this.term.term;
    this.id = await this.host.tp.spawn(
      { ...this.profile, cwd: this.cwd },
      t.cols,
      t.rows,
      (bytes) => t.write(bytes),
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
