// Settings, as a sheet over the terminal. It lives in the main window on purpose: a second
// Tauri window is outside the app's capability scope, so its webview comes up with no IPC —
// a black rectangle.
import type { App } from "./app";
import { withDefaults, type Config, type Transport } from "./transport";
import { ACTIONS, bindKeys, chordFor, chordOf, FIXED, pretty } from "./keymap";
import { renderList, renderLogins } from "./settings-lists";
import { toast } from "./ui";
import { COLORS as MENU_COLORS } from "./menu";

export interface Ctx {
  tp: Transport;
  config: Config;
  /** Opens a tab under this account and runs the Claude Code login in it. */
  signIn(account: import("./transport").Account): void;
  newTab(account: import("./transport").Account): void;
  save(): void;
  rerender(): void;
  go(section: string): void;
}

const ICONS: Record<string, string> = {
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><polyline points="7 10 10 13 7 16"/><line x1="13" y1="16" x2="17" y2="16"/>',
  appearance: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
  rail: '<path d="M4 5h16"/><path d="M4 12h10"/><path d="M4 19h7"/>',
  startup: '<path d="M12 3v6"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>',
  profiles: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9h4"/>',
  accounts: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  hosts: '<rect x="2.5" y="4.5" width="19" height="7" rx="2"/><rect x="2.5" y="13.5" width="19" height="6" rx="2"/><circle cx="6.5" cy="8" r="1"/><circle cx="6.5" cy="16.5" r="1"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  updates: '<path d="M12 3v11"/><polyline points="8 10 12 14 16 10"/><path d="M4 18h16"/>',
  files: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logins: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M17 8l2 2 4-4"/>',
  snippets: '<polyline points="8 7 4 12 8 17"/><polyline points="16 7 20 12 16 17"/><line x1="13" y1="5" x2="11" y2="19"/>',
};

const SECTIONS: { id: string; title: string; group: string; icon: string; count?(c: Config): number }[] = [
  { id: "terminal", title: "Terminal", group: "The app", icon: "terminal" },
  { id: "appearance", title: "Appearance", group: "The app", icon: "appearance" },
  { id: "rail", title: "Rail & layout", group: "The app", icon: "rail" },
  { id: "startup", title: "Startup & session", group: "The app", icon: "startup" },
  { id: "profiles", title: "Profiles", group: "Things you make", icon: "profiles", count: (c) => c.profiles.length },
  { id: "accounts", title: "Accounts", group: "Things you make", icon: "accounts", count: (c) => c.accounts.length },
  { id: "logins", title: "Claude logins", group: "Things you make", icon: "logins" },
  { id: "hosts", title: "SSH hosts", group: "Things you make", icon: "hosts", count: (c) => c.hosts.length },
  { id: "projects", title: "Projects", group: "Things you make", icon: "projects", count: (c) => c.projects.length },
  { id: "snippets", title: "Snippets", group: "Things you make", icon: "snippets", count: (c) => c.snippets.length },
  { id: "keyboard", title: "Keyboard", group: "System", icon: "keyboard" },
  { id: "updates", title: "Updates", group: "System", icon: "updates" },
  { id: "files", title: "Files & reset", group: "System", icon: "files" },
];

export function installSettings(app: App) {
  const root = document.querySelector<HTMLElement>("#settings")!;
  const nav = root.querySelector<HTMLElement>(".sw-nav")!;
  const body = root.querySelector<HTMLElement>(".sw-main")!;
  const crumb = root.querySelector<HTMLElement>(".crumb")!;
  const saved = root.querySelector<HTMLElement>(".saved")!;
  const pathEl = root.querySelector<HTMLElement>(".path")!;
  let active = "terminal";
  let savedTimer = 0;

  const ctx: Ctx = {
    tp: app.tp,
    signIn: (account) => {
      close();
      void app.signIn(account);
    },
    newTab: (account) => {
      close();
      void app.newTab(undefined, undefined, null, account.id);
    },
    get config() {
      return app.config;
    },
    save() {
      app.applyConfig();
      app.applyRailWidth();
      document.querySelector("#rail")!.classList.toggle("collapsed", app.config.rail_collapsed);
      app.paint();
      app.persistConfig();
      saved.hidden = false;
      clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => (saved.hidden = true), 1400);
    },
    rerender: () => render(),
    go: (section) => {
      active = section;
      render();
    },
  } as Ctx;

  root.querySelector<HTMLButtonElement>(".close")!.onclick = () => close();
  root.addEventListener("mousedown", (e) => e.target === root && close());
  void app.tp.configPath().then((p) => (pathEl.textContent = p)).catch(() => {});

  function close() {
    root.hidden = true;
    app.tab?.active.focus();
  }

  function render() {
    nav.replaceChildren();
    let group = "";
    for (const section of SECTIONS) {
      if (section.group !== group) {
        group = section.group;
        const capEl = document.createElement("div");
        capEl.className = "cap";
        capEl.textContent = group;
        nav.appendChild(capEl);
      }
      const b = document.createElement("button");
      b.className = section.id === active ? "on" : "";
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[section.icon]}</svg>`;
      b.appendChild(document.createTextNode(section.title));
      const n = section.count?.(app.config);
      if (n !== undefined) {
        const c = document.createElement("span");
        c.className = "count";
        c.textContent = String(n);
        b.appendChild(c);
      }
      b.onclick = () => ctx.go(section.id);
      nav.appendChild(b);
    }
    const version = document.createElement("div");
    version.className = "version";
    version.textContent = "OBPTerm";
    void app.tp.appVersion().then((v) => (version.textContent = `OBPTerm ${v}`));
    nav.appendChild(version);

    crumb.textContent = SECTIONS.find((s) => s.id === active)?.title ?? "";
    body.scrollTop = 0;
    body.replaceChildren(SECTION_BODY[active]!(ctx));
  }

  return {
    open(section?: string) {
      if (section && SECTIONS.some((s) => s.id === section)) active = section;
      root.hidden = false;
      render();
      root.querySelector<HTMLButtonElement>(".sw-nav button.on")?.focus();
    },
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}

export type Settings = ReturnType<typeof installSettings>;

// ---- controls -------------------------------------------------------------------------------

export function card(...rows: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-card";
  el.append(...rows);
  return el;
}

export function cap(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-cap";
  el.textContent = text;
  return el;
}

export function head(title: string, blurb: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-head-block";
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = blurb;
  el.append(h, p);
  return el;
}

export function row(label: string, hint: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-row";
  const rl = document.createElement("div");
  rl.className = "rl";
  const b = document.createElement("b");
  b.textContent = label;
  const s = document.createElement("span");
  s.textContent = hint;
  rl.append(b, s);
  el.append(rl, control);
  return el;
}

export function text(value: string, onChange: (v: string) => void, opts: { width?: number; placeholder?: string; password?: boolean } = {}): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "sw-input";
  el.type = opts.password ? "password" : "text";
  el.value = value;
  if (opts.placeholder) el.placeholder = opts.placeholder;
  if (opts.width) el.style.width = `${opts.width}px`;
  el.onchange = () => onChange(el.value.trim());
  return el;
}

export function number(value: number | null, onChange: (v: number | null) => void, opts: { width?: number; placeholder?: string } = {}): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "sw-input num";
  el.type = "number";
  el.value = value === null ? "" : String(value);
  el.placeholder = opts.placeholder ?? "";
  el.style.width = `${opts.width ?? 120}px`;
  el.onchange = () => onChange(el.value === "" ? null : Number(el.value));
  return el;
}

export function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = document.createElement("button");
  el.className = `sw-switch${on ? " on" : ""}`;
  el.setAttribute("role", "switch");
  el.setAttribute("aria-checked", String(on));
  el.innerHTML = "<i></i>";
  el.onclick = () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  };
  return el;
}

export function segmented(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-seg";
  for (const opt of options) {
    const b = document.createElement("button");
    b.className = opt.value === value ? "on" : "";
    b.textContent = opt.label;
    b.onclick = () => {
      for (const other of el.children) other.classList.remove("on");
      b.classList.add("on");
      onChange(opt.value);
    };
    el.appendChild(b);
  }
  return el;
}

export function slider(value: number, min: number, max: number, step: number, unit: string, onChange: (v: number) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-slider";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement("div");
  out.className = "sw-input num";
  out.style.width = "84px";
  out.textContent = `${value}${unit}`;
  input.oninput = () => {
    out.textContent = `${input.value}${unit}`;
    onChange(Number(input.value));
  };
  el.append(input, out);
  return el;
}

export function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const el = document.createElement("select");
  el.className = "sw-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = opt.value === value;
    el.appendChild(o);
  }
  el.onchange = () => onChange(el.value);
  return el;
}

export const COLORS = MENU_COLORS.map((c) => c.value);

export function swatches(value: string | null, onChange: (v: string | null) => void, withDefault = true): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-swatches";
  const paint = (chosen: string | null) => {
    for (const child of el.children) {
      (child as HTMLElement).classList.toggle("on", (child as HTMLElement).dataset.value === (chosen ?? ""));
    }
  };
  const add = (color: string | null) => {
    const b = document.createElement("button");
    b.className = "sw-swatch";
    b.dataset.value = color ?? "";
    b.style.background = color ?? "transparent";
    b.title = color ?? "Default";
    b.onclick = () => {
      paint(color);
      onChange(color);
    };
    el.appendChild(b);
  };
  if (withDefault) add(null);
  for (const c of COLORS) add(c);
  paint(value);
  return el;
}

export function button(label: string, onClick: () => void, kind = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `sw-btn ${kind}`.trim();
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

// ---- sections -------------------------------------------------------------------------------

const SECTION_BODY: Record<string, (ctx: Ctx) => HTMLElement> = {
  terminal: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    wrap.append(
      head("Terminal", "How every shell looks and behaves. A profile can override the shell and the folder."),
      card(
        row("Font", "Bundled with the app, so it looks the same on a fresh machine.",
          text(c.font_family, (v) => { c.font_family = v; ctx.save(); }, { width: 280 })),
        row("Font size", "Ctrl+wheel and Ctrl +/− change this live.",
          slider(c.font_size, 8, 40, 1, "", (v) => { c.font_size = v; ctx.save(); })),
        row("Scrollback", "Lines kept per pane. Find searches all of them.",
          number(c.scrollback, (v) => { c.scrollback = v ?? 10000; ctx.save(); }, { width: 130 })),
        row("Cursor", "",
          segmented([{ value: "bar", label: "Bar" }, { value: "block", label: "Block" }, { value: "underline", label: "Underline" }],
            c.cursor_style, (v) => { c.cursor_style = v as Config["cursor_style"]; ctx.save(); })),
        row("Blink the cursor", "", toggle(c.cursor_blink, (v) => { c.cursor_blink = v; ctx.save(); })),
      ),
      card(
        row("Default folder", "Created if it does not exist. %USERPROFILE% and ~ are expanded.",
          text(c.default_cwd ?? "", (v) => { c.default_cwd = v || null; ctx.save(); }, { width: 280, placeholder: "C:\\OBP" })),
        row("Default profile", "What Ctrl+Shift+T opens.",
          select(c.profiles.map((p) => ({ value: p.id, label: p.name })), c.default_profile, (v) => { c.default_profile = v; ctx.save(); })),
        row("Copy on select", "Finishing a drag puts the selection on the clipboard — no keypress.",
          toggle(c.copy_on_select, (v) => { c.copy_on_select = v; ctx.save(); })),
        row("Right-click", "Copies the selection, pastes when there is none.",
          toggle(c.right_click_paste, (v) => { c.right_click_paste = v; ctx.save(); })),
        row("Capture folder", "Where Ctrl+Shift+L writes a pane's raw output.",
          withButton(text(c.capture_dir ?? "", (v) => { c.capture_dir = v || null; ctx.save(); }, { width: 240, placeholder: "the app's logs folder" }),
            button("Open", () => void ctx.tp.reveal("logs")))),
      ),
      cap("Memory"),
      card(
        row("Put a tab to sleep after it leaves the screen", "A tab you are not looking at loses its terminal; the shell keeps running in the session host and the tab wakes on click. The rail still shows what a sleeping shell is doing, and a pane waiting on a permission question is never slept. Zero keeps every terminal alive.",
          slider(c.sleep_after_seconds, 0, 600, 30, " s", (v) => { c.sleep_after_seconds = v; ctx.save(); })),
      ),
      card(
        row("Keep at most this many terminals awake", "Each live terminal holds a WebGL context, and the window gets about sixteen before Chromium starts taking them back — at which point every terminal drops to the slow renderer and the app seizes. Waking a pane past this many sleeps the one you looked at longest ago. Zero removes the ceiling.",
          slider(c.max_live_panes, 0, 20, 1, "", (v) => { c.max_live_panes = v; ctx.save(); })),
      ),
      card(
        row("Sleep a finished agent after", "A Claude session that finished and sat unread is /exited to free its memory (~335 MB each); the tab stays and clicking it resumes the same conversation. Zero never does.",
          slider(c.eco_after_minutes, 0, 240, 10, " min", (v) => { c.eco_after_minutes = v; ctx.save(); })),
      ),
      card(
        row("Flag a conversation when its context passes", "The gauge exists but says nothing unless you look at it — and the session filling up is usually one you are not looking at. Past this, the rail shows it and an unfocused window gets the same notification a bell would raise. Right-click the tab to /compact. Zero never flags.",
          slider(c.context_warn_pct, 0, 100, 5, "%", (v) => { c.context_warn_pct = v; ctx.save(); })),
      ),
      card(
        row("Exit idle sessions when memory passes", "The machine running out of RAM is what actually freezes this window — it thrashes on swap and everything stalls for minutes. Above this, idle sessions are /exited oldest first, sleeping ones included, until it comes down. Each tab stays and resumes on click. Zero never does.",
          slider(c.eco_memory_pct, 0, 100, 5, "%", (v) => { c.eco_memory_pct = v; ctx.save(); })),
      ),
      cap("Claude Code"),
      card(
        row("Keep Remote Control off for new sessions", "Claude Code activates Remote Control for every new session, and /remote-control only turns it off for the session you are in — so an app update, which restarts them all, brought it back every time. This writes the documented `remoteControlAtStartup: false` into every account's settings.json and re-asserts it on each launch. Turning this off removes the key again rather than setting it true.",
          toggle(c.no_remote_control, (v) => { c.no_remote_control = v; ctx.save(); toast(v ? "Written on the next launch — restart the app to apply now" : "Removed on the next launch"); })),
      ),
      cap("Being told"),
      card(
        row("Notify when a pane asks for you", "A desktop notification carrying what the program said, and the taskbar flashes until you come back.",
          toggle(c.notify_bell, (v) => { c.notify_bell = v; ctx.save(); })),
        row("Notify when a busy pane goes quiet", "The completion signal that needs nothing from the shell — it works over SSH too.",
          toggle(c.notify_silence, (v) => { c.notify_silence = v; ctx.save(); })),
        row("Quiet means", "How long a pane that was working must be silent before it counts as finished.",
          slider(c.silence_seconds, 5, 120, 5, " s", (v) => { c.silence_seconds = v; ctx.save(); })),
        row("Push to your phone (ntfy)", "Full publish URL including the topic, e.g. https://ntfy.obp.com.tr/obpterm. Fires only when the window is unfocused, for the same events as the desktop notification. Empty = the app contacts nothing.",
          text(c.ntfy_url ?? "", (v) => { c.ntfy_url = v || null; ctx.save(); }, { width: 300, placeholder: "https://ntfy.obp.com.tr/obpterm" })),
        row("ntfy access token", "When the topic needs one. Never leaves this machine in exports or the settings mirror.",
          text(c.ntfy_token ?? "", (v) => { c.ntfy_token = v || null; ctx.save(); }, { width: 300, placeholder: "tk_…" })),
        row("Stay awake while agents work", "Holds Windows out of sleep while any Claude session is working, so an unattended run survives the lid. The ☕ chip in the status bar shows when it is active.",
          toggle(c.keep_awake, (v) => { c.keep_awake = v; ctx.save(); })),
      ),
      note(
        "The rail marks a tab that rang while you were elsewhere. Claude Code only rings when its " +
          "preferredNotifChannel is set to terminal_bell. For a notification that says which session " +
          "wants you, set it to iterm2 — OBPTerm speaks that protocol, and it reaches you over SSH too.",
      ),
      note("Every change here is written straight to config.json — no Apply button, and the file stays hand-editable."),
    );
    return wrap;
  },

  appearance: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    const preview = document.createElement("div");
    preview.className = "sw-card";
    preview.style.padding = "14px 18px";
    preview.style.font = "12.5px/1.6 var(--mono)";
    preview.style.whiteSpace = "pre";
    const paintPreview = () => {
      const t = c.theme;
      preview.style.background = t.background ?? "#0a0e14";
      preview.innerHTML =
        `<span style="color:${t.green}">obp@vps</span> <span style="color:${t.blue}">~/iot-stack</span> <span style="color:${c.accent}">❯</span> git status --short\n` +
        `<span style="color:${t.yellow}"> M</span> src/style.css   <span style="color:${t.red}"> D</span> old.ts   <span style="color:${t.magenta}">??</span> design/\n` +
        `<span style="color:${t.cyan}">→</span> 2 files changed, <span style="color:${t.foreground}">1 deletion</span> <span style="background:${t.cursor};color:${t.background}"> </span>`;
    };
    paintPreview();

    const ansi = document.createElement("div");
    ansi.className = "sw-ansi";
    const keys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
      "background", "foreground", "cursor", "cursorAccent"];
    for (const key of keys) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "color";
      input.value = (c.theme[key] ?? "#000000").slice(0, 7);
      input.oninput = () => {
        c.theme[key] = input.value;
        paintPreview();
        ctx.save();
      };
      const span = document.createElement("span");
      span.textContent = key.replace(/([A-Z])/g, " $1").toLowerCase();
      label.append(input, span);
      ansi.appendChild(label);
    }

    wrap.append(
      head("Appearance", "The window's accent, and the colours the shell paints with."),
      cap("Preview"),
      preview,
      card(
        row("Accent", "One accent marks the active thing. A project or tab colour overrides it locally.",
          withInput(swatches(c.accent, (v) => { c.accent = v ?? "#ff8a1e"; paintPreview(); ctx.save(); }, false),
            text(c.accent, (v) => { c.accent = v; paintPreview(); ctx.save(); }, { width: 100 }))),
        row("Dim inactive panes", "The focused pane keeps its accent edge; the others fade back.",
          toggle(c.dim_inactive_panes, (v) => { c.dim_inactive_panes = v; ctx.save(); })),
      ),
      cap("Terminal palette"),
      card(ansi),
      note("Colours apply to new output immediately; the 16 ANSI slots are what programs ask for by name."),
    );
    return wrap;
  },

  rail: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    wrap.append(
      head("Rail & layout", "The list of sessions down the left side."),
      card(
        row("Rail width", "Also set by dragging the rail's edge.",
          slider(c.rail_width, 150, 420, 2, " px", (v) => { c.rail_width = v; ctx.save(); })),
        row("Start collapsed", "Ctrl+Shift+B toggles it while you work.",
          toggle(c.rail_collapsed, (v) => { c.rail_collapsed = v; ctx.save(); })),
      ),
    );
    return wrap;
  },

  startup: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    wrap.append(
      head("Startup & session", "What happens when OBPTerm opens, and what it remembers."),
      card(
        row("Reopen tabs on launch", "Panes, project, colour and each pane's folder come back. Off = always start with one tab.",
          toggle(c.restore_session, (v) => { c.restore_session = v; ctx.save(); })),
        row("Default account", "The environment new shells start with.",
          select([{ value: "", label: "—" }, ...c.accounts.map((a) => ({ value: a.id, label: a.name }))],
            c.default_account ?? "", (v) => { c.default_account = v || null; ctx.save(); })),
      ),
      cap("Token meters"),
      card(
        row("Real limit from a statusLine file", "Claude Code hands its rate_limits payload to a statusLine command; point this at a file one writes and the meters show the real percentage and reset time.",
          text(c.limits_file ?? "", (v) => { c.limits_file = v || null; ctx.save(); }, { width: 280, placeholder: "~/.claude/limits.json" })),
        row("…or from a machine of yours", "Anything serving {fiveHour:{used,resetsAt},weekly:{…}} — the homelab /ssh/ terminal already does.",
          text(c.limits_url ?? "", (v) => { c.limits_url = v || null; ctx.save(); }, { width: 280, placeholder: "http://host:3007/api/status" })),
        row("Your budget", "Fallback when neither source above is set: the status bar shows this machine's own token counts against these budgets. With a statusLine file or URL configured, the real percentages win and this is ignored.",
          pair(number(c.quota_5h_tokens, (v) => { c.quota_5h_tokens = v; ctx.save(); }, { width: 130, placeholder: "5h" }),
            number(c.quota_7d_tokens, (v) => { c.quota_7d_tokens = v; ctx.save(); }, { width: 130, placeholder: "7d" }))),
      ),
    );
    return wrap;
  },

  keyboard: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    const list = document.createElement("div");
    list.className = "sw-card sw-keys";
    for (const action of ACTIONS) {
      const el = document.createElement("div");
      el.className = "sw-key";
      const b = document.createElement("b");
      b.textContent = action.label;
      const chordBtn = document.createElement("button");
      chordBtn.className = "sw-chord";
      const overridden = !!c.keybindings[action.id] && c.keybindings[action.id] !== action.def;
      chordBtn.textContent = pretty(chordFor(c, action));
      chordBtn.classList.toggle("changed", overridden);
      chordBtn.title = "Click, then press the new keys. Esc cancels.";
      chordBtn.onclick = () => {
        chordBtn.textContent = "press keys…";
        chordBtn.classList.add("recording");
        const done = () => { window.removeEventListener("keydown", grab, true); ctx.rerender(); };
        const grab = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === "Escape") return done();
          const chord = chordOf(e);
          if (!chord) return; // a bare modifier — keep listening
          const holder = ACTIONS.find((a) => a !== action && chordFor(c, a) === chord);
          if (holder) {
            toast(`${pretty(chord)} already runs “${holder.label}” — free it first`);
            return done();
          }
          if (chord === action.def) delete c.keybindings[action.id];
          else c.keybindings[action.id] = chord;
          bindKeys(c);
          ctx.save();
          done();
        };
        window.addEventListener("keydown", grab, true);
      };
      el.append(b, chordBtn);
      if (overridden) {
        const reset = document.createElement("button");
        reset.className = "sw-btn";
        reset.textContent = "Reset";
        reset.onclick = () => {
          delete c.keybindings[action.id];
          bindKeys(c);
          ctx.save();
          ctx.rerender();
        };
        el.appendChild(reset);
      }
      list.appendChild(el);
    }
    const fixed = document.createElement("div");
    fixed.className = "sw-card sw-keys";
    for (const binding of FIXED) {
      const el = document.createElement("div");
      el.className = "sw-key";
      const b = document.createElement("b");
      b.textContent = binding.label;
      const keys = document.createElement("span");
      keys.className = "keys";
      for (const k of binding.keys.split(" ")) {
        const chip = document.createElement("span");
        chip.textContent = k;
        keys.appendChild(chip);
      }
      el.append(b, keys);
      fixed.appendChild(el);
    }
    const resetAll = document.createElement("button");
    resetAll.className = "sw-btn";
    resetAll.textContent = "Reset all to defaults";
    resetAll.onclick = () => {
      c.keybindings = {};
      bindKeys(c);
      ctx.save();
      ctx.rerender();
    };
    wrap.append(
      head("Keyboard", "Click a shortcut, press the new keys. Whatever you bind is reserved by the app; everything else goes to the shell, F5 included."),
      list,
      resetAll,
      note("Fixed keys — these carry a number or a direction and cannot be rebound:"),
      fixed,
    );
    return wrap;
  },

  updates: (ctx) => {
    const c = ctx.config;
    const wrap = document.createElement("div");
    const status = document.createElement("div");
    status.className = "sw-row";
    const rl = document.createElement("div");
    rl.className = "rl";
    const b = document.createElement("b");
    b.textContent = "Checking…";
    const s = document.createElement("span");
    rl.append(b, s);
    const action = button("Check again", () => void check(), "");
    status.append(rl, action);

    const check = async () => {
      b.textContent = "Checking…";
      s.textContent = "";
      try {
        const release = await ctx.tp.updateCheck(c.update_repo ?? "", c.github_token);
        const current = await ctx.tp.appVersion();
        if (release.newer) {
          b.textContent = `${release.version} is available`;
          s.textContent = `You are on ${current}. Installing closes OBPTerm, replaces it and reopens your tabs.`;
          action.textContent = "Install and restart";
          action.className = "sw-btn primary";
          action.onclick = () => {
            action.disabled = true;
            action.textContent = "Downloading…";
            void ctx.tp.updateInstall(release, c.github_token).catch((e) => {
              action.disabled = false;
              action.textContent = "Install and restart";
              toast(`Update failed: ${e}`);
            });
          };
        } else {
          b.textContent = "App is up to date";
          s.textContent = `${current} is the newest release.`;
        }
      } catch (e) {
        b.textContent = "Could not check";
        s.textContent = String(e);
      }
    };
    void check();

    wrap.append(
      head("Updates", "Releases come from GitHub; installing is always a button press."),
      card(status),
      card(
        row("Release source", "owner/repo. A public repository needs no token.",
          text(c.update_repo ?? "", (v) => { c.update_repo = v || null; ctx.save(); }, { width: 280 })),
        row("Access token", "Only for a private repository.",
          text(c.github_token ?? "", (v) => { c.github_token = v || null; ctx.save(); }, { width: 280, placeholder: "not set", password: true })),
        row("Check for updates automatically", "On launch and once a day while running. Just checks; it never installs on its own.",
          toggle(c.update_check_on_launch, (v) => { c.update_check_on_launch = v; ctx.save(); })),
      ),
    );
    return wrap;
  },

  files: (ctx) => {
    const wrap = document.createElement("div");
    wrap.append(
      head("Files & reset", "Where OBPTerm keeps things, and the way back to defaults."),
      card(
        row("Claude Code hooks", "A marked block in settings.json that tells OBPTerm what each session is doing. Installed automatically; this takes it back out.",
          button("Remove hooks & status line", () => {
            const dirs = [...new Set(["~/.claude", ...ctx.config.accounts.map((a) => a.claude_dir).filter((d): d is string => !!d)])];
            void ctx.tp.hooksRemove(dirs).then((n) => toast(n ? `Hooks + status line removed from ${n} settings file${n > 1 ? "s" : ""}` : "Nothing of ours was installed"));
          })),
        row("Config and session", "config.json holds these settings; session.json holds the open tabs.",
          button("Show folder", () => void ctx.tp.reveal("config"))),
      ),
      card(
        row("Mirror settings to a folder", "Every save also writes obpterm-config.json here. Point it at a OneDrive or Google Drive folder and the cloud client carries it to the next laptop. Tokens and Claude credentials never ride along.",
          text(ctx.config.backup_dir ?? "", (v) => { ctx.config.backup_dir = v || null; ctx.save(); }, { width: 300, placeholder: "C:\\Users\\you\\OneDrive\\obpterm" })),
        row("Save settings to a file", "A portable copy in your Downloads folder — the manual version of the mirror.",
          button("Save settings to file", () => {
            void ctx.tp.configExport(ctx.config).then((p) => toast(`Saved ${p}`)).catch((e) => toast(String(e)));
          })),
        row("Load settings from a file", "Restores a mirror or an exported copy. Replaces these settings; open tabs are left alone.",
          importButton(ctx)),
        captureRow(ctx),
        row("Keep captures for", "Older ones are deleted when the app starts. Zero keeps them forever.",
          slider(ctx.config.capture_keep_days, 0, 180, 5, " days", (v) => { ctx.config.capture_keep_days = v; ctx.save(); })),
        row("And under", "When the folder is bigger than this, the oldest go first. Zero is no cap.",
          slider(ctx.config.capture_max_mb, 0, 4096, 64, " MB", (v) => { ctx.config.capture_max_mb = v; ctx.save(); })),
      ),
      card(
        row("Reset every setting", "Profiles, accounts, hosts, projects and colours go back to defaults. Open tabs are left alone.",
          button("Reset to defaults", () => {
            void ctx.tp.configReset().then((fresh) => {
              Object.assign(ctx.config, fresh);
              ctx.save();
              ctx.rerender();
              toast("Settings reset to defaults");
            });
          }, "danger")),
      ),
    );
    return wrap;
  },

  profiles: (ctx) => renderList(ctx, "profiles"),
  accounts: (ctx) => renderList(ctx, "accounts"),
  hosts: (ctx) => renderList(ctx, "hosts"),
  projects: (ctx) => renderList(ctx, "projects"),
  snippets: (ctx) => renderList(ctx, "snippets"),
  logins: (ctx) => {
    const wrap = document.createElement("div");
    wrap.append(
      head("Claude Code logins", "Two logins, one folder: switch which one is live. Same layout and same guards as the VPS's cc_account.py, so a profile saved here reads the same way there."),
      renderLogins(ctx),
      note("Switching applies to shells started afterwards. A running claude keeps the login it started with — and blocks the switch, because it would rotate the token underneath the swap."),
    );
    return wrap;
  },
};

/** Says how much the capture folder is holding, and offers to drop the empty ones. */
function importButton(ctx: Ctx): HTMLElement {
  const holder = document.createElement("span");
  const pick = document.createElement("input");
  pick.type = "file";
  pick.accept = ".json,application/json";
  pick.hidden = true;
  pick.onchange = async () => {
    const file = pick.files?.[0];
    pick.value = "";
    if (!file) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      return toast(`Not valid JSON: ${e}`);
    }
    if (!Array.isArray(parsed.profiles) || !parsed.profiles.length) {
      return toast("That file has no profiles — not an OBPTerm settings file");
    }
    // Machine-bound leftovers never import; the fence around secrets holds on the way in too.
    delete parsed.session;
    delete parsed.github_token;
    delete parsed.ntfy_token;
    const backupDir = ctx.config.backup_dir; // keep THIS machine's mirror target
    Object.assign(ctx.config, withDefaults(parsed as Partial<Config>), { backup_dir: parsed.backup_dir ?? backupDir });
    bindKeys(ctx.config);
    ctx.save();
    ctx.rerender();
    toast("Settings imported — fonts, shortcuts and profiles are live");
  };
  const btn = button("Load settings from file", () => pick.click());
  holder.append(btn, pick);
  return holder;
}

function captureRow(ctx: Ctx): HTMLElement {
  const prune = button("Clean up now", () => void run(true));
  const show = button("Show folder", () => void ctx.tp.reveal("logs"));
  const el = row("Capture logs", "Counting…", pair(prune, show));
  const hint = el.querySelector("span")!;

  const run = async (deleting = false) => {
    const dir = ctx.config.capture_dir || (await ctx.tp.logDir().catch(() => ""));
    if (!dir) return;
    if (deleting) {
      const [gone, freed] = await ctx.tp
        .pruneCaptures(dir, ctx.config.capture_keep_days, ctx.config.capture_max_mb)
        .catch(() => [0, 0] as [number, number]);
      toast(gone ? `Deleted ${gone} capture${gone > 1 ? "s" : ""}, freed ${fmtBytes(freed)}` : "Nothing to clean up");
    }
    const [count, bytes, empty] = await ctx.tp.captureStats(dir).catch(() => [0, 0, 0] as [number, number, number]);
    hint.textContent = count
      ? `${count} file${count > 1 ? "s" : ""}, ${fmtBytes(bytes)}${empty ? ` · ${empty} empty` : ""}`
      : "Nothing captured yet.";
    const days = ctx.config.capture_keep_days;
    const cap = ctx.config.capture_max_mb;
    prune.disabled = count === 0;
    prune.title = [
      days ? `deletes captures older than ${days} days` : "no age limit",
      cap ? `keeps the folder under ${cap} MB` : "no size cap",
      "never touches a pane that is still recording",
    ].join(" · ");
  };
  void run();
  return el;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

export function note(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-note";
  el.textContent = message;
  return el;
}

function pair(a: HTMLElement, b: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.style.display = "flex";
  el.style.gap = "8px";
  el.append(a, b);
  return el;
}

function withButton(input: HTMLElement, btn: HTMLElement): HTMLElement {
  return pair(input, btn);
}

function withInput(a: HTMLElement, b: HTMLElement): HTMLElement {
  const el = pair(a, b);
  el.style.alignItems = "center";
  el.style.gap = "12px";
  return el;
}

