// What each Claude session is doing, from its own hooks. The reducer owns three timing rules
// (learned from NodeTerm's design notes): a late PostToolUse must not un-finish a session
// that just stopped; a lost Stop must decay; Esc fires no hook, so typing into a waiting
// pane settles it back to working without one.
import type { App } from "./app";
import type { Pane } from "./pane";

/** One agent a session fanned out, tracked start to finish. */
export interface FannedAgent {
  id: string;
  kind: string;
  task: string;
  /** The last tool call it made, already phrased ("Grep pty.rs"). */
  feed: string | null;
  startedAt: number;
  endedAt: number | null;
  tools: number;
}

export interface AgentState {
  /** working | done | waiting | blocked, or null = no agent seen in this pane. */
  state: "working" | "done" | "waiting" | "blocked" | null;
  /** "Editing pty.rs", the last message, or the permission request's words. */
  detail: string | null;
  sessionId: string | null;
  /** Set while a permission request is held open for the rail's verdict. */
  pendingId: string | null;
  options: string[];
  /** The tool a held permission request is about ("Bash"), and its raw input. */
  tool: string | null;
  toolInput: string | null;
  /** A Stop arrived while you were elsewhere and you have not looked yet. */
  unread: boolean;
  lastToolAt: number;
  workingSince: number;
  /** Agents this session spawned, newest last. Ended ones linger until the turn finishes. */
  fanned: FannedAgent[];
}

export const blank = (): AgentState => ({
  state: null,
  detail: null,
  sessionId: null,
  pendingId: null,
  options: [],
  tool: null,
  toolInput: null,
  unread: false,
  lastToolAt: 0,
  workingSince: 0,
  fanned: [],
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
  tool?: string | null;
  tool_input?: string | null;
  agent_id?: string | null;
  agent_kind?: string | null;
  agent_task?: string | null;
  agent_event?: string | null;
}

/** Applies one hook event. Returns what the app should do beyond repainting. */
export function reduce(a: AgentState, u: AgentUpdate, focused: boolean): "notify" | "auto-pass" | null {
  if (u.session_id) a.sessionId = u.session_id;
  // Fan-out bookkeeping runs first and, for agent-owned events, INSTEAD of the session's own
  // state machine: one agent's tool call is not the session doing something new.
  if (u.agent_id && u.agent_event) {
    applyFan(a, u);
    if (u.agent_event !== "spawned") return null;
  }
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
      a.tool = null;
      a.toolInput = null;
      if (u.detail) a.detail = u.detail;
      return null;
    }
    case "done": {
      // The turn is over: agents that belonged to it stop being live.
      for (const f of a.fanned) f.endedAt ??= Date.now();
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
      a.tool = u.tool ?? null;
      a.toolInput = u.tool_input ?? null;
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

/** Opens, feeds and closes the agents a session fanned out. */
function applyFan(a: AgentState, u: AgentUpdate) {
  const id = u.agent_id!;
  let agent = a.fanned.find((f) => f.id === id);
  if (!agent) {
    if (u.agent_event === "finished") return; // a close for an agent we never saw open
    agent = { id, kind: u.agent_kind || "agent", task: u.agent_task || "", feed: null, startedAt: Date.now(), endedAt: null, tools: 0 };
    a.fanned.push(agent);
  }
  if (u.agent_kind) agent.kind = u.agent_kind;
  if (u.agent_task) agent.task = u.agent_task;
  if (u.agent_event === "tool") {
    agent.tools += 1;
    if (u.detail) agent.feed = u.detail;
  }
  if (u.agent_event === "finished") agent.endedAt = Date.now();
}

/** Agents still running for this session. */
export function liveAgents(a: AgentState): FannedAgent[] {
  return a.fanned.filter((f) => f.endedAt === null);
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
    app.lastAgentEventAt = Date.now();
    if (u.agent_id) app.lastFanEventAt = Date.now();
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

/** Commands whose approval should never be muscle memory. Graded on the RAW command the
 *  hook carried (or the detail line when that is all there is). */
const DANGER: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,       // rm -rf and friends
  /\bgit\s+push\s+.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+\.\s*$/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z|fi)?sh\b/i, // curl | bash
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bformat\s+[a-z]:/i,
  /\bdrop\s+(table|database)\b/i,
  /\bchmod\s+-R\s+777/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /--no-verify\b/i,
];

/** True when this held request deserves a red card and a deliberate key. */
export function isDangerous(a: AgentState): boolean {
  const hay = a.toolInput ?? a.detail ?? "";
  return !!hay && DANGER.some((re) => re.test(hay));
}

/** True when this pane runs Claude Code — the exe or an arg says so. */
export function isClaudePane(pane: Pane): boolean {
  const hay = `${pane.profile.exe} ${pane.profile.args.join(" ")}`.toLowerCase();
  return hay.includes("claude") || pane.claudeSessionId !== null;
}
