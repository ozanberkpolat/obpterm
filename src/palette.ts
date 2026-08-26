// Ctrl+K: one list over profiles, hosts, projects, tabs and the app's own commands.
import type { App } from "./app";

interface Entry {
  group: string;
  label: string;
  hint?: string;
  run(): void;
}

export function installPalette(app: App) {
  const root = document.querySelector<HTMLElement>("#palette")!;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const list = root.querySelector<HTMLElement>(".results")!;
  let entries: Entry[] = [];
  let filtered: Entry[] = [];
  let cursor = 0;

  const build = (): Entry[] => [
    ...app.config.profiles.map((p, i) => ({
      group: "New tab", label: p.name, hint: i < 9 ? `Ctrl+Shift+${i + 1}` : "", run: () => void app.newTab(p),
    })),
    ...app.config.hosts.map((h) => ({
      group: "SSH", label: h.name, hint: h.user ? `${h.user}@${h.host}` : h.host, run: () => void app.newTabForHost(h),
    })),
    ...app.config.projects.map((p) => ({
      group: "Project", label: `New tab in ${p.name}`, run: () => void app.newTab(undefined, p.id),
    })),
    ...app.tabs.map((t, i) => ({
      group: "Go to",
      label: app.title(t),
      // Only the first nine have a key; advertising Ctrl+27 would be a lie.
      hint: i < 9 ? `Ctrl+${i + 1}` : (t.active.cwd ?? ""),
      run: () => app.activate(t),
    })),
    ...app.config.snippets.map((s) => ({
      group: "Snippet",
      label: s.name,
      hint: s.text.length > 42 ? `${s.text.slice(0, 42)}…` : s.text,
      run: () => app.sendKey(s.send ? `${s.text}\r` : s.text),
    })),
    { group: "Panes", label: "Split right", hint: "Alt+Shift+=", run: () => void app.splitPane("row") },
    { group: "Panes", label: "Split down", hint: "Alt+Shift+-", run: () => void app.splitPane("col") },
    { group: "Panes", label: "Find in scrollback", hint: "Ctrl+Shift+F", run: () => app.find.open() },
    { group: "Panes", label: app.tab?.active.logPath ? "Stop capture" : "Start capture", hint: "Ctrl+Shift+L", run: () => void app.toggleLog() },
    { group: "App", label: "Agents — every session and what it fanned out", hint: "Ctrl+G", run: () => app.showView("agents") },
    { group: "App", label: "New tab in a worktree — isolated copy of this repo", hint: "Ctrl+Shift+U", run: () => void import("./rail").then((r) => r.newWorktree(app)) },
    { group: "App", label: "Restart the session host (ends shells, restores tabs)", run: () => void app.restartHost() },
    { group: "App", label: "Settings", hint: "Ctrl+Shift+,", run: () => app.settings.open() },
    { group: "App", label: "Manage snippets", run: () => app.settings.open("snippets") },
    { group: "App", label: "Appearance", run: () => app.settings.open("appearance") },
    { group: "App", label: "Check for updates", run: () => void app.status.checkUpdates() },
    { group: "App", label: "Quit and end every shell", run: () => void app.quitAll() },
    { group: "App", label: app.config.rail_collapsed ? "Show the rail" : "Collapse the rail", hint: "Ctrl+Shift+B", run: () => app.toggleRail() },
  ];

  /** Subsequence match, so "spr" finds "Split right". */
  const score = (entry: Entry, query: string): number => {
    if (!query) return 1;
    // Twelve Claude sessions are told apart by their directory and host, not their titles.
    const hay = `${entry.group} ${entry.label} ${entry.hint ?? ""}`.toLowerCase();
    const direct = hay.indexOf(query);
    if (direct >= 0) return 1000 - direct;
    let i = 0;
    for (const ch of query) {
      i = hay.indexOf(ch, i);
      if (i < 0) return 0;
      i += 1;
    }
    return 1;
  };

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    filtered = entries
      .map((e) => ({ e, s: score(e, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.e);
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "pempty";
      empty.textContent = "No matches";
      return list.replaceChildren(empty);
    }
    list.replaceChildren(
      ...filtered.map((entry, i) => {
        const el = document.createElement("button");
        el.className = `presult${i === cursor ? " on" : ""}`;
        const g = document.createElement("span");
        g.className = "pgroup";
        g.textContent = entry.group;
        const l = document.createElement("span");
        l.className = "plabel";
        l.textContent = entry.label;
        el.append(g, l);
        if (entry.hint) {
          const h = document.createElement("span");
          h.className = "k";
          h.textContent = entry.hint;
          el.appendChild(h);
        }
        el.onclick = () => pick(entry);
        el.onmouseenter = () => {
          cursor = i;
          for (const [j, child] of [...list.children].entries()) child.classList.toggle("on", j === i);
        };
        return el;
      }),
    );
  };

  const pick = (entry: Entry | undefined) => {
    close();
    entry?.run();
  };

  const close = () => {
    root.hidden = true;
    app.tab?.active.focus();
  };

  input.addEventListener("input", () => {
    cursor = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") return close();
    if (e.key === "Enter") return pick(filtered[cursor]);
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      cursor = Math.min(filtered.length - 1, cursor + 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      cursor = Math.max(0, cursor - 1);
      e.preventDefault();
    } else return;
    draw();
  });
  root.addEventListener("mousedown", (e) => e.target === root && close());

  return {
    open(prefill = "") {
      entries = build();
      input.value = prefill;
      cursor = 0;
      root.hidden = false;
      draw();
      input.focus();
      input.select();
    },
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}

export type Palette = ReturnType<typeof installPalette>;
