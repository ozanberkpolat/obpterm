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
  /** The agent that spawned it, or null when the session did. Agents delegate too. */
  parent: string | null;
}

export interface AgentState {
  /** How many of each tool this session has called: {Bash: 7, Edit: 2}. What it is DOING,
   *  where `detail` only says what it did last. */
  toolCounts?: Record<string, number>;
  /** What its finished fan-outs came to, kept as the agents themselves are pruned away. */
  fanStats?: { count: number; totalMs: number; longestMs: number };
  /** When a session that was working went quiet for good — it stopped reporting mid-task
   *  rather than finishing. Null while it is talking. */
  stalledSince?: number | null;
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
  /** default | acceptEdits | bypassPermissions | plan — what the session is running as. */
  mode: string | null;
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
  toolCounts: {},
  fanStats: { count: 0, totalMs: 0, longestMs: 0 },
  stalledSince: null,
  fanned: [],
  mode: null,
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
  agent_ref?: string | null;
  /** Who spawned it: null for the session's own fan-out, an agent id when an agent delegated. */
  agent_parent?: string | null;
  mode?: string | null;
}

/** Applies one hook event. Returns what the app should do beyond repainting. */
export function reduce(a: AgentState, u: AgentUpdate, focused: boolean): "notify" | "auto-pass" | null {
  if (u.session_id) a.sessionId = u.session_id;
  if (u.mode) a.mode = u.mode;
  // Fan-out bookkeeping runs first and, for agent-owned events, INSTEAD of the session's own
  // state machine: one agent's tool call is not the session doing something new.
  if (u.agent_id && u.agent_event) {
    applyFan(a, u);
    if (u.agent_event !== "spawned") return null;
  }
  // Count the tool before the state machine gets a look: `a.tool` is cleared on every working
  // event (it belongs to the blocked-state display), so the tally has to be its own.
  if (u.tool && u.state === "working" && u.agent_event !== "tool") {
    a.toolCounts = a.toolCounts ?? {};
    a.toolCounts[u.tool] = (a.toolCounts[u.tool] ?? 0) + 1;
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
  // The delegation and the agent have different ids; `linked` is where they meet. Rekey the
  // entry the spawn opened instead of starting a second one — counting both is what showed
  // four agents for two.
  if (u.agent_event === "linked" && u.agent_ref) {
    const opened = a.fanned.find((f) => f.id === u.agent_ref);
    if (opened) {
      // Anything keyed to the old id follows it: a grandchild opened against the call id would
      // otherwise be orphaned the moment its parent is rekeyed.
      for (const f of a.fanned) if (f.parent === opened.id) f.parent = id;
      opened.id = id;
      if (u.agent_kind) opened.kind = u.agent_kind;
      if (u.agent_task) opened.task = u.agent_task;
      if (u.agent_parent !== undefined) opened.parent = u.agent_parent ?? null;
      return;
    }
  }
  let agent = a.fanned.find((f) => f.id === id);
  if (!agent) {
    if (u.agent_event === "finished") return; // a close for an agent we never saw open
    agent = {
      id,
      kind: u.agent_kind || "agent",
      task: u.agent_task || "",
      feed: null,
      startedAt: Date.now(),
      endedAt: null,
      tools: 0,
      parent: u.agent_parent ?? null,
    };
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

/** Agents drop off the views a few seconds after they finish — a finished agent is history,
 *  and the map is for what is happening. With one exception: an agent that spawned agents of
 *  its own is the trunk they hang from. A parent that launched background sub-agents finishes
 *  the moment they are launched, so dropping it would strand three running children and
 *  re-parent them onto the session — the fan-out would look flat when it is two deep. */
export function pruneFan(a: AgentState): boolean {
  const cutoff = Date.now() - 6000;
  const before = a.fanned.length;
  // An agent's own duration is computed, shown for six seconds and then deleted with it. Fold
  // it into the session's running total on the way out, so "that fan-out took 2m40s across four
  // agents" survives the agent that earned it.
  for (const f of a.fanned) {
    if (f.endedAt === null || f.endedAt > cutoff || hasLiveDescendant(a, f.id)) continue;
    const ms = f.endedAt - f.startedAt;
    a.fanStats = a.fanStats ?? { count: 0, totalMs: 0, longestMs: 0 };
    a.fanStats.count += 1;
    a.fanStats.totalMs += ms;
    a.fanStats.longestMs = Math.max(a.fanStats.longestMs, ms);
  }
  a.fanned = a.fanned.filter((f) => f.endedAt === null || f.endedAt > cutoff || hasLiveDescendant(a, f.id));
  return a.fanned.length !== before;
}

/** True when some agent below this one — at any depth — is still running. */
export function hasLiveDescendant(a: AgentState, id: string): boolean {
  const kids = a.fanned.filter((f) => f.parent === id);
  return kids.some((k) => k.endedAt === null || hasLiveDescendant(a, k.id));
}

/** Agents still running for this session. */
export function liveAgents(a: AgentState): FannedAgent[] {
  return a.fanned.filter((f) => f.endedAt === null);
}

/** The decays that need no event: a lost Stop, and reading what was unread. */
export function tick(a: AgentState): boolean {
  if (a.state === "working" && a.workingSince && Date.now() - a.workingSince > WORKING_STALE_MS) {
    // It was working and has reported nothing for twenty minutes. This used to blank the state
    // outright, which drew it as "idle" — identical to a session sitting quietly at a prompt.
    // Those are the two states most worth telling apart when twenty agents are running: one is
    // finished with you, the other stopped talking mid-task. Keep the fact, mark it stalled.
    a.stalledSince = a.workingSince;
    a.state = null;
    a.detail = null;
    return true;
  }
  // Any fresh state at all means it is talking again.
  if (a.stalledSince && a.state !== null) {
    a.stalledSince = null;
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
      // The pending id makes the push answerable: two buttons that publish the verdict back.
      app.agentAlert(tab ? app.title(tab) : "Claude", pane.agent.detail ?? "needs you", pane.agent.pendingId);
    }
    app.paintSoon();
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

/** A session that bypasses permissions never asks, so answer buttons are noise on it. */
export function asksPermission(a: AgentState): boolean {
  return a.mode !== "bypassPermissions";
}

/** Short label for the session's mode, or "" for the ordinary one. */
export function modeLabel(a: AgentState): string {
  switch (a.mode) {
    case "bypassPermissions": return "auto";
    case "acceptEdits": return "accept edits";
    case "plan": return "plan";
    default: return "";
  }
}

/** True when this pane runs Claude Code — the exe or an arg says so. */
export function isClaudePane(pane: Pane): boolean {
  const hay = `${pane.profile.exe} ${pane.profile.args.join(" ")}`.toLowerCase();
  return hay.includes("claude") || pane.claudeSessionId !== null;
}
