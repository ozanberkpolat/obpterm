// Find bar over the focused pane's scrollback (@xterm/addon-search).
import type { App } from "./app";

export function installFind(app: App) {
  const bar = document.querySelector<HTMLElement>("#find")!;
  const input = bar.querySelector<HTMLInputElement>("input")!;
  const count = bar.querySelector<HTMLElement>(".count")!;
  const caseBtn = bar.querySelector<HTMLButtonElement>(".case")!;
  const reBtn = bar.querySelector<HTMLButtonElement>(".regex")!;

  const opts = () => ({
    caseSensitive: caseBtn.classList.contains("on"),
    regex: reBtn.classList.contains("on"),
    // Neon green on request: matches must be findable at a glance in any scrollback.
    decorations: {
      matchBackground: "#136b06",
      activeMatchBackground: "#39ff14",
      matchOverviewRuler: "#39ff14",
      activeMatchColorOverviewRuler: "#39ff14",
    },
  });

  const search = (dir: 1 | -1, fromCursor = false) => {
    const pane = app.tab?.active;
    if (!pane) return;
    const term = input.value;
    if (!term) {
      pane.term.search.clearDecorations();
      count.textContent = "";
      return;
    }
    const found = dir > 0 ? pane.term.search.findNext(term, opts()) : pane.term.search.findPrevious(term, opts());
    count.textContent = found ? "" : "no match";
    count.classList.toggle("miss", !found);
    if (fromCursor) return;
  };

  input.addEventListener("input", () => search(1));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") search(e.shiftKey ? -1 : 1);
    if (e.key === "Escape") close();
  });
  bar.querySelector<HTMLButtonElement>(".prev")!.onclick = () => search(-1);
  bar.querySelector<HTMLButtonElement>(".next")!.onclick = () => search(1);
  bar.querySelector<HTMLButtonElement>(".close")!.onclick = () => close();
  for (const b of [caseBtn, reBtn]) {
    b.onclick = () => {
      b.classList.toggle("on");
      search(1);
    };
  }

  function close() {
    bar.hidden = true;
    app.tab?.active.term.search.clearDecorations();
    app.tab?.active.focus();
  }

  return {
    open() {
      bar.hidden = false;
      const sel = app.tab?.active.term.term.getSelection();
      if (sel && !sel.includes("\n")) input.value = sel;
      input.focus();
      input.select();
      if (input.value) search(1);
    },
    close,
    get isOpen() {
      return !bar.hidden;
    },
  };
}

export type Find = ReturnType<typeof installFind>;
