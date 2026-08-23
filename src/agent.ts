// What each Claude session is doing, from its own hooks. The reducer owns three timing rules
// (learned from NodeTerm's design notes): a late PostToolUse must not un-finish a session
// that just stopped; a lost Stop must decay; Esc fires no hook, so typing into a waiting
// pane settles it back to working without one.
import type { App } from "./app";
import type { Pane } from "./pane";

export interface AgentState {
  /** working | done | waiting | blocked, or null = no agent seen in this pane. */
  state: "working" | "done" | "waiting" | "blocked" | null;
  /** "Editing pty.rs", the last message, or the permission request's words. */
  detail: string | null;
  sessionId: string | null;
  /** Set while a permission request is held open for the rail's verdict. */
  pendingId: string | null;
  options: string[];
  /** A Stop arrived while you were elsewhere and you have not looked yet. */
  unread: boolean;
  lastToolAt: number;
  workingSince: number;
}

export const blank = (): AgentState => ({
  state: null,
  detail: null,
  sessionId: null,
  pendingId: null,
  options: [],
  unread: false,
  lastToolAt: 0,
  workingSince: 0,
});

const DONE_HOLDOFF_MS = 3000;
const WORKING_STALE_MS = 20 * 60_000;
const INTERRUPT_SETTLE_MS = 1500;

export interface AgentUpdate {
  pane: number;
  state: string;
  session_id: string | null;
  detail: string | null;
  pending_id: string | null;
  options: string[];
}

/** Applies one hook event. Returns what the app should do beyond repainting. */
export function reduce(a: AgentState, u: AgentUpdate, focused: boolean): "notify" | "auto-pass" | null {
  if (u.session_id) a.sessionId = u.session_id;
  switch (u.state) {
    case "working": {
      // A tool event trailing a Stop by moments is Claude's parallel hooks, not new work.
      if (a.state === "done" && Date.now() - a.lastToolAt < DONE_HOLDOFF_MS) {
        a.lastToolAt = Date.now();
        return null;
      }
      if (a.state !== "working") a.workingSince = Date.now();
      a.state = "working";
      a.lastToolAt = Date.now();
      a.pendingId = null;
      a.options = [];
      if (u.detail) a.detail = u.detail;
      return null;
    }
    case "done": {
      a.state = "done";
      a.detail = u.detail ?? a.detail;
      a.pendingId = null;
      a.options = [];
      a.unread = !focused;
      return null;
    }
    case "blocked":
    case "waiting": {
      a.state = u.state;
      a.detail = u.detail ?? a.detail;
      a.pendingId = u.pending_id;
      a.options = u.options;
      // The user is already looking at this pane: pass the held request straight through so
      // the normal in-pane prompt appears without the 40-second wait.
      if (u.state === "blocked" && focused && u.pending_id) return "auto-pass";
      return "notify";
    }
    case "idle_rescue": {
      // idle_prompt also fires after a normal Stop and mid-permission; it may only rescue a
      // session that still *looks* busy, or it would mark finished work as needing you.
      if (a.state === "working") {
        a.state = "waiting";
        return "notify";
      }
      return null;
    }
    case "reset": {
      const sessionId = a.sessionId;
      Object.assign(a, blank());
      a.sessionId = sessionId;
      a.state = "working";
      a.workingSince = Date.now();
      return null;
    }
    case "ended": {
      Object.assign(a, blank());
      return null;
    }
    default:
      return null;
  }
}

/** The decays that need no event: a lost Stop, and reading what was unread. */
export function tick(a: AgentState): boolean {
  if (a.state === "working" && a.workingSince && Date.now() - a.workingSince > WORKING_STALE_MS) {
    a.state = null;
    a.detail = null;
    return true;
  }
  return false;
}

export function installAgentEvents(app: App) {
  app.tp.onAgent((u) => {
    const pane = app.tabs.flatMap((t) => app.panesOf(t)).find((p) => p.id === u.pane);
    if (!pane) return;
    const focused = app.isFocused(pane);
    const action = reduce(pane.agent, u, focused);
    if (u.session_id) pane.claudeSessionId = u.session_id;
    if (action === "auto-pass" && u.pending_id) {
      void app.tp.agentAnswer(u.pending_id, null);
      pane.agent.pendingId = null;
    } else if (action === "notify" && !focused) {
      const tab = app.tabs.find((t) => app.panesOf(t).includes(pane));
      app.agentAlert(tab ? app.title(tab) : "Claude", pane.agent.detail ?? "needs you");
    }
    app.paint();
  });

  // Typing into a waiting pane is the answer arriving in-pane; settle it without a hook.
  document.querySelector("#panes")!.addEventListener("keydown", () => {
    const pane = app.tab?.active;
    if (!pane || !["blocked", "waiting", "done"].includes(pane.agent.state ?? "")) return;
    const before = pane.agent.state;
    window.setTimeout(() => {
      if (pane.agent.state === before) {
        pane.agent.state = before === "done" ? null : "working";
        pane.agent.workingSince = Date.now();
        app.paint();
      }
    }, INTERRUPT_SETTLE_MS);
  });
}

/** True when this pane runs Claude Code — the exe or an arg says so. */
export function isClaudePane(pane: Pane): boolean {
  const hay = `${pane.profile.exe} ${pane.profile.args.join(" ")}`.toLowerCase();
  return hay.includes("claude") || pane.claudeSessionId !== null;
}
