// The settings window: a sidebar of sections over one config file. Every control writes on
// change — there is no Apply button, and config.json stays hand-editable.
import { pickTransport, withDefaults, type Config, type Transport } from "./transport";
import { KEYMAP } from "./keymap";
import { renderList } from "./settings-lists";
import { toast } from "./ui";
import "./settings.css";

export interface Ctx {
  tp: Transport;
  config: Config;
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
};

const SECTIONS: { id: string; title: string; group: string; icon: string; count?(c: Config): number }[] = [
  { id: "terminal", title: "Terminal", group: "The app", icon: "terminal" },
  { id: "appearance", title: "Appearance", group: "The app", icon: "appearance" },
  { id: "rail", title: "Rail & layout", group: "The app", icon: "rail" },
  { id: "startup", title: "Startup & session", group: "The app", icon: "startup" },
  { id: "profiles", title: "Profiles", group: "Things you make", icon: "profiles", count: (c) => c.profiles.length },
  { id: "accounts", title: "Accounts", group: "Things you make", icon: "accounts", count: (c) => c.accounts.length },
  { id: "hosts", title: "SSH hosts", group: "Things you make", icon: "hosts", count: (c) => c.hosts.length },
  { id: "projects", title: "Projects", group: "Things you make", icon: "projects", count: (c) => c.projects.length },
  { id: "keyboard", title: "Keyboard", group: "System", icon: "keyboard" },
  { id: "updates", title: "Updates", group: "System", icon: "updates" },
  { id: "files", title: "Files & reset", group: "System", icon: "files" },
];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function main() {
  const tp = await pickTransport();
  let config = withDefaults(await tp.loadConfig());
  let active = location.hash.slice(1) || "terminal";
  if (!SECTIONS.some((s) => s.id === active)) active = "terminal";
  let saveTimer = 0;

  const ctx: Ctx = {
    tp,
    get config() {
      return config;
    },
    save() {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void tp.saveConfig(config).then(showSaved).catch((e) => toast(`Not saved: ${e}`));
      }, 250);
      applyAccent(config);
    },
    rerender: () => render(),
    go: (section) => {
      active = section;
      location.hash = section;
      render();
    },
  } as Ctx;

  tp.onConfigChanged(() => {
    // The terminal window saved something (a colour, a rail drag) — take its copy.
    void tp.loadConfig().then((fresh) => {
      config = withDefaults(fresh);
      render();
    });
  });
  tp.configPath().then((p) => ($("#sw-head .path").textContent = p)).catch(() => {});
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !(e.target as HTMLElement)?.matches("input, select")) close();
  });
  $("#sw-head .close").addEventListener("click", () => close());
  applyAccent(config);
  render();

  function close() {
    void tp.windowAction("settings", "close");
  }

  function showSaved() {
    const el = $("#sw-head .saved");
    el.hidden = false;
    window.setTimeout(() => (el.hidden = true), 1400);
  }

  function render() {
    const nav = $("#sw-nav");
    nav.replaceChildren();
    let group = "";
    for (const section of SECTIONS) {
      if (section.group !== group) {
        group = section.group;
        const cap = document.createElement("div");
        cap.className = "cap";
        cap.textContent = group;
        nav.appendChild(cap);
      }
      const b = document.createElement("button");
      b.className = section.id === active ? "on" : "";
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[section.icon]}</svg>`;
      b.appendChild(document.createTextNode(section.title));
      const n = section.count?.(config);
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
    void tp.appVersion().then((v) => (version.textContent = `OBPTerm ${v}`));
    nav.appendChild(version);

    $("#sw-head .crumb").textContent = SECTIONS.find((s) => s.id === active)?.title ?? "";
    const main = $("#sw-main");
    main.scrollTop = 0;
    main.replaceChildren(SECTION_BODY[active]!(ctx));
  }
}

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

export const COLORS = ["#ff8a1e", "#4c8dff", "#2fd6a3", "#b48cff", "#22d3ee", "#ffb454", "#ff6b73", "#8b97a8"];

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

function applyAccent(config: Config) {
  document.documentElement.style.setProperty("--accent", config.accent);
  document.documentElement.style.setProperty(
    "--accent-fill",
    `linear-gradient(135deg, color-mix(in srgb, ${config.accent} 78%, white), ${config.accent})`,
  );
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
        row("Right-click", "Copies the selection, pastes when there is none.",
          toggle(c.right_click_paste, (v) => { c.right_click_paste = v; ctx.save(); })),
        row("Capture folder", "Where Ctrl+Shift+L writes a pane's raw output.",
          withButton(text(c.capture_dir ?? "", (v) => { c.capture_dir = v || null; ctx.save(); }, { width: 240, placeholder: "the app's logs folder" }),
            button("Open", () => void ctx.tp.reveal("logs")))),
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
          withInput(swatches(c.accent, (v) => { c.accent = v ?? "#ff8a1e"; paintPreview(); ctx.save(); ctx.rerender(); }, false),
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
        row("Your budget", "The status bar shows a percentage of these instead of raw totals. Left empty it shows totals — Anthropic's real limit is not readable from disk.",
          pair(number(c.quota_5h_tokens, (v) => { c.quota_5h_tokens = v; ctx.save(); }, { width: 130, placeholder: "5h" }),
            number(c.quota_7d_tokens, (v) => { c.quota_7d_tokens = v; ctx.save(); }, { width: 130, placeholder: "7d" }))),
      ),
    );
    return wrap;
  },

  keyboard: () => {
    const wrap = document.createElement("div");
    const list = document.createElement("div");
    list.className = "sw-card sw-keys";
    for (const binding of KEYMAP) {
      const el = document.createElement("div");
      el.className = "sw-key";
      const b = document.createElement("b");
      b.textContent = binding.label;
      const keys = document.createElement("span");
      keys.className = "keys";
      for (const k of binding.keys) {
        const s = document.createElement("span");
        s.textContent = k;
        keys.appendChild(s);
      }
      el.append(b, keys);
      list.appendChild(el);
    }
    wrap.append(head("Keyboard", "What the app reserves. Everything else goes to the shell, F5 included."), list,
      note("Rebinding is not in yet — these are fixed for now."));
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
        row("Check on launch", "Just checks; it never installs on its own.",
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
        row("Config and session", "config.json holds these settings; session.json holds the open tabs.",
          button("Show folder", () => void ctx.tp.reveal("config"))),
        row("Capture logs", "Everything Ctrl+Shift+L has written.",
          button("Show folder", () => void ctx.tp.reveal("logs"))),
      ),
      card(
        row("Reset every setting", "Profiles, accounts, hosts, projects and colours go back to defaults. Open tabs are left alone.",
          button("Reset to defaults", () => {
            void ctx.tp.configReset().then((fresh) => {
              Object.assign(ctx.config, withDefaults(fresh));
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
};

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

main().catch((e) => {
  console.error(e);
  document.querySelector("#sw-main")!.textContent = String(e);
});
