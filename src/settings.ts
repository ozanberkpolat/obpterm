// One editor for everything the app can create: profiles, accounts, hosts, projects.
// Every list is add / edit / delete — nothing here can be created and then be stuck.
import type { App } from "./app";
import type { Account, Host, Profile, Project } from "./transport";
import { COLORS } from "./menu";
import { toast } from "./ui";

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "color" | "profile" | "password" | "kv" | "number";
};

interface Section<T> {
  id: string;
  title: string;
  hint: string;
  fields: Field[];
  list(app: App): T[];
  create(app: App): T;
  remove(app: App, item: T): void;
  /** Rows the user cannot delete, with the reason. */
  locked?(app: App, item: T): string | null;
}

const id = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

const SECTIONS: Section<Record<string, unknown>>[] = [
  {
    id: "profiles",
    title: "Profiles",
    hint: "The shells the + Tab menu offers.",
    fields: [
      { key: "name", label: "Name", placeholder: "PowerShell 7" },
      { key: "exe", label: "Executable", placeholder: "pwsh.exe" },
      { key: "args", label: "Arguments", placeholder: "-NoLogo" },
      { key: "cwd", label: "Start in", placeholder: "C:\\OBP" },
      { key: "env", label: "Environment", placeholder: "KEY=value, KEY2=value2", kind: "kv" },
    ],
    list: (app) => app.config.profiles as unknown as Record<string, unknown>[],
    create: (app) => {
      const p: Profile = { id: id("p"), name: "New profile", exe: "pwsh.exe", args: [], cwd: null, env: {} };
      app.config.profiles.push(p);
      return p as unknown as Record<string, unknown>;
    },
    remove: (app, item) => {
      app.config.profiles = app.config.profiles.filter((p) => p !== (item as unknown as Profile));
    },
    locked: (app) =>
      app.config.profiles.length === 1 ? "The last profile cannot be deleted — the app needs a shell to start." : null,
  },
  {
    id: "accounts",
    title: "Accounts",
    hint: "Environment presets for new shells. CLAUDE_CONFIG_DIR, AZURE_CONFIG_DIR, AWS_PROFILE…",
    fields: [
      { key: "name", label: "Name", placeholder: "Work" },
      { key: "env", label: "Environment", placeholder: "CLAUDE_CONFIG_DIR=C:\\Users\\you\\.claude-work", kind: "kv" },
      { key: "claude_dir", label: "Claude config dir", placeholder: "C:\\Users\\you\\.claude" },
      { key: "color", label: "Colour", kind: "color" },
    ],
    list: (app) => app.config.accounts as unknown as Record<string, unknown>[],
    create: (app) => {
      const a: Account = { id: id("a"), name: "New account", env: {}, claude_dir: null, color: null };
      app.config.accounts.push(a);
      return a as unknown as Record<string, unknown>;
    },
    remove: (app, item) => {
      const account = item as unknown as Account;
      app.config.accounts = app.config.accounts.filter((a) => a !== account);
      if (app.config.default_account === account.id) app.config.default_account = null;
    },
  },
  {
    id: "hosts",
    title: "SSH hosts",
    hint: "Targets for Ctrl+Shift+H and the status bar's host chip.",
    fields: [
      { key: "name", label: "Name", placeholder: "Hetzner VPS" },
      { key: "host", label: "Host", placeholder: "100.84.61.54" },
      { key: "user", label: "User", placeholder: "obp" },
      { key: "port", label: "Port", placeholder: "22", kind: "number" },
      { key: "identity", label: "Key file", placeholder: "C:\\Users\\you\\.ssh\\id_ed25519" },
      { key: "project", label: "Open in project", kind: "text", placeholder: "project id (optional)" },
    ],
    list: (app) => app.config.hosts as unknown as Record<string, unknown>[],
    create: (app) => {
      const h: Host = { id: id("h"), name: "New host", host: "", user: null, port: null, identity: null, project: null };
      app.config.hosts.push(h);
      return h as unknown as Record<string, unknown>;
    },
    remove: (app, item) => {
      app.config.hosts = app.config.hosts.filter((h) => h !== (item as unknown as Host));
    },
  },
  {
    id: "projects",
    title: "Projects",
    hint: "Tab groups. Deleting one keeps its tabs, ungrouped.",
    fields: [
      { key: "name", label: "Name", placeholder: "Homelab" },
      { key: "color", label: "Colour", kind: "color" },
      { key: "cwd", label: "Start in", placeholder: "C:\\OBP\\homelab" },
      { key: "default_profile", label: "Default profile", kind: "profile" },
    ],
    list: (app) => app.config.projects as unknown as Record<string, unknown>[],
    create: (app) => app.addProject("New project") as unknown as Record<string, unknown>,
    remove: (app, item) => app.deleteProject(item as unknown as Project),
  },
];

export function installSettings(app: App) {
  const root = document.querySelector<HTMLElement>("#settings")!;
  const nav = root.querySelector<HTMLElement>(".tabs")!;
  const body = root.querySelector<HTMLElement>(".body")!;
  let active = SECTIONS[0]!.id;

  root.querySelector<HTMLButtonElement>(".close")!.onclick = () => close();
  root.addEventListener("mousedown", (e) => e.target === root && close());

  function close() {
    root.hidden = true;
    app.tab?.active.focus();
  }

  function render() {
    nav.replaceChildren(
      ...SECTIONS.map((s) => {
        const b = document.createElement("button");
        b.textContent = s.title;
        b.className = s.id === active ? "on" : "";
        b.onclick = () => {
          active = s.id;
          render();
        };
        return b;
      }),
    );
    const section = SECTIONS.find((s) => s.id === active)!;
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = section.hint;
    const rows = section.list(app).map((item) => row(app, section, item, render));
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = `Add ${section.title.replace(/s$/, "").toLowerCase()}`;
    add.onclick = () => {
      section.create(app);
      app.persistConfig();
      app.paint();
      render();
    };
    body.replaceChildren(hint, ...rows, add);
  }

  return {
    open(sectionId?: string) {
      if (sectionId) active = sectionId;
      root.hidden = false;
      render();
    },
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}

function row(app: App, section: Section<Record<string, unknown>>, item: Record<string, unknown>, rerender: () => void) {
  const el = document.createElement("div");
  el.className = "row";
  for (const field of section.fields) el.appendChild(input(app, field, item, rerender));

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "Delete";
  const locked = section.locked?.(app, item) ?? null;
  if (locked) {
    del.disabled = true;
    del.title = locked;
  }
  del.onclick = () => {
    const index = section.list(app).indexOf(item);
    section.remove(app, item);
    app.persistConfig();
    app.paint();
    rerender();
    toast(`Deleted “${String(item.name ?? "item")}”`, {
      label: "Undo",
      run: () => {
        section.list(app).splice(index, 0, item);
        app.persistConfig();
        app.paint();
        rerender();
      },
    });
  };
  el.appendChild(del);
  return el;
}

function input(app: App, field: Field, item: Record<string, unknown>, rerender: () => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = `field ${field.kind ?? "text"}`;
  const caption = document.createElement("span");
  caption.textContent = field.label;
  wrap.appendChild(caption);

  const commit = (value: unknown) => {
    item[field.key] = value;
    app.persistConfig();
    app.paint();
  };

  if (field.kind === "color") {
    const picker = document.createElement("div");
    picker.className = "swatches";
    for (const c of [{ name: "Default", value: "" }, ...COLORS]) {
      const b = document.createElement("button");
      b.className = "swatch-btn" + ((item[field.key] ?? "") === c.value ? " on" : "");
      b.style.background = c.value || "transparent";
      b.title = c.name;
      b.onclick = (e) => {
        e.preventDefault();
        commit(c.value || null);
        rerender();
      };
      picker.appendChild(b);
    }
    wrap.appendChild(picker);
    return wrap;
  }

  if (field.kind === "profile") {
    const select = document.createElement("select");
    for (const opt of [{ id: "", name: "—" }, ...app.config.profiles]) {
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent = opt.name;
      o.selected = (item[field.key] ?? "") === opt.id;
      select.appendChild(o);
    }
    select.onchange = () => commit(select.value || null);
    wrap.appendChild(select);
    return wrap;
  }

  const el = document.createElement("input");
  el.type = field.kind === "number" ? "number" : "text";
  el.placeholder = field.placeholder ?? "";
  const value = item[field.key];
  el.value =
    field.kind === "kv"
      ? Object.entries((value ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(", ")
      : Array.isArray(value)
        ? value.join(" ")
        : value == null
          ? ""
          : String(value);
  el.onchange = () => {
    if (field.kind === "kv") return commit(parseKv(el.value));
    if (field.key === "args") return commit(el.value.split(/\s+/).filter(Boolean));
    if (field.kind === "number") return commit(el.value ? Number(el.value) : null);
    commit(el.value.trim() || null);
  };
  wrap.appendChild(el);
  return wrap;
}

/** "A=1, B=2" → { A: "1", B: "2" }. Values may contain "=", keys may not. */
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

export type Settings = ReturnType<typeof installSettings>;
