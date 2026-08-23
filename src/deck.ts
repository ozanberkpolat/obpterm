// The Agent Deck (Ctrl+G): one live card per Claude session across every tab — state, the
// last lines of its screen, and the held permission answerable right here. The rail's badge
// counts what this view shows; clicking a card jumps to its pane.
import type { App, Tab } from "./app";
import { isClaudePane } from "./agent";
import type { Pane } from "./pane";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

interface Card {
  el: HTMLElement;
  name: HTMLElement;
  chip: HTMLElement;
  tail: HTMLElement;
  ask: HTMLElement;
  foot: HTMLElement;
  actions: HTMLElement;
}

/** Loudest first: what the grid sorts by. */
const ORDER = ["blocked", "waiting", "working", "done", null] as const;

export class Deck {
  isOpen = false;
  private root = $("#deck");
  private grid = $("#deck .dgrid");
  private summary = $("#deck .dsummary");
  private cards = new Map<Pane, Card>();

  constructor(private app: App) {
    this.root.addEventListener("mousedown", (e) => e.target === this.root && this.close());
    $("#deck .dclose").addEventListener("click", () => this.close());
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.root.hidden = false;
    this.paint();
  }

  close() {
    this.isOpen = false;
    this.root.hidden = true;
    this.app.tab?.active.focus();
  }

  /** Every Claude pane, loudest first, with the tab it lives in. */
  panes(): { pane: Pane; tab: Tab }[] {
    const all = this.app.tabs.flatMap((tab) => this.app.panesOf(tab).map((pane) => ({ pane, tab })));
    return all
      .filter(({ pane }) => isClaudePane(pane))
      .sort((a, b) => ORDER.indexOf(a.pane.agent.state) - ORDER.indexOf(b.pane.agent.state));
  }

  paint() {
    if (!this.isOpen) return;
    const entries = this.panes();
    const counts = this.app.agentCounts();
    this.summary.replaceChildren();
    const add = (text: string, cls = "") => {
      const s = document.createElement("span");
      if (cls) s.className = cls;
      s.textContent = text;
      this.summary.appendChild(s);
    };
    if (counts.needsYou) add(`${counts.needsYou} need${counts.needsYou > 1 ? "" : "s"} you`, "hot");
    add([counts.working && `${counts.working} working`, counts.done && `${counts.done} done`, counts.sleeping && `${counts.sleeping} sleeping`].filter(Boolean).join(" · ") || "");

    const seen = new Set<Pane>();
    for (const { pane, tab } of entries) {
      seen.add(pane);
      this.grid.appendChild(this.patch(pane, tab).el); // append re-orders in place
    }
    for (const [pane, card] of this.cards) {
      if (!seen.has(pane)) {
        card.el.remove();
        this.cards.delete(pane);
      }
    }
    this.grid.classList.toggle("empty", !entries.length);
    $("#deck .dempty").hidden = entries.length > 0;
  }

  private patch(pane: Pane, tab: Tab): Card {
    const card = this.cards.get(pane) ?? this.build(pane);
    const app = this.app;
    const a = pane.agent;
    const state = pane.eco ? "eco" : pane.asleep ? "asleep" : (a.state ?? "shell");
    card.el.dataset.state = state;
    card.el.style.setProperty("--card-accent", app.accent(tab));
    set(card.name, app.title(tab));
    set(card.chip, CHIP[state] ?? state);
    set(card.tail, this.tail(pane));
    // The held question, in the agent's words, with its options when it asked one.
    const ask = a.state === "blocked" || a.state === "waiting" ? (a.detail ?? "") : "";
    set(card.ask.querySelector<HTMLElement>(".q")!, ask);
    const options = ask && a.options.length ? a.options : [];
    const opts = card.ask.querySelector<HTMLElement>(".opts")!;
    if (opts.dataset.options !== options.join("|")) {
      opts.dataset.options = options.join("|");
      opts.replaceChildren(
        ...options.map((o) => {
          const li = document.createElement("li");
          li.textContent = o;
          return li;
        }),
      );
    }
    card.ask.hidden = !ask;
    card.actions.hidden = !(a.state === "blocked" && a.pendingId);
    set(card.foot, [pane.profile.name, pane.cwd?.split(/[\\/]/).filter(Boolean).pop()].filter(Boolean).join(" · "));
    return card;
  }

  private build(pane: Pane): Card {
    const el = document.createElement("article");
    el.className = "dcard";
    el.innerHTML =
      `<header><span class="ddot"></span><span class="dname"></span><span class="dchip"></span></header>` +
      `<pre class="dtail"></pre>` +
      `<div class="dask" hidden><div class="q"></div><ul class="opts"></ul></div>` +
      `<div class="dactions" hidden><button class="allow">Allow</button><button class="deny">Deny</button></div>` +
      `<footer class="dfoot"></footer>`;
    el.addEventListener("click", () => {
      const tab = this.app.tabs.find((t) => this.app.panesOf(t).includes(pane));
      if (!tab) return;
      this.close();
      this.app.activate(tab);
      this.app.focusPane(pane);
    });
    const stopThen = (fn: () => void) => (e: Event) => {
      e.stopPropagation();
      fn();
    };
    el.querySelector<HTMLButtonElement>(".allow")!.onclick = stopThen(() => void this.app.answerAgent(pane, true));
    el.querySelector<HTMLButtonElement>(".deny")!.onclick = stopThen(() => void this.app.answerAgent(pane, false));
    const card: Card = {
      el,
      name: el.querySelector(".dname")!,
      chip: el.querySelector(".dchip")!,
      tail: el.querySelector(".dtail")!,
      ask: el.querySelector(".dask")!,
      foot: el.querySelector(".dfoot")!,
      actions: el.querySelector(".dactions")!,
    };
    this.cards.set(pane, card);
    return card;
  }

  /** The last lines of the pane's screen. A sleeping pane has no terminal to read. */
  private tail(pane: Pane, rows = 9): string {
    if (pane.eco) return "sleeping to save memory — click to resume the conversation";
    if (pane.asleep) {
      const h = pane.heldState;
      return h && Date.now() - h.last_output < 5000
        ? "asleep — the shell is still printing; click to watch"
        : "asleep — click to wake";
    }
    if (pane.exited) return `exited${pane.exitCode ? ` with code ${pane.exitCode}` : ""}`;
    const buf = pane.term.term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.length - 1; i >= 0 && lines.length < rows; i--) {
      const line = buf.getLine(i)?.translateToString(true).trimEnd() ?? "";
      if (lines.length || line) lines.unshift(line);
    }
    return lines.join("\n");
  }
}

const CHIP: Record<string, string> = {
  blocked: "needs you",
  waiting: "needs you",
  working: "working",
  done: "done",
  eco: "sleeping",
  asleep: "asleep",
  shell: "shell",
};

function set(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
