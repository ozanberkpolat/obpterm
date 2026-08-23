// Profiles, accounts, SSH hosts and projects: one list-and-form screen, four field sets.
// Everything here can be added, edited and deleted — deletes are undoable.
import { button, card, COLORS, note, number, select, swatches, text, toggle, type Ctx } from "./settings-panel";
import { toast } from "./ui";
import type { Account, Config, Host, Profile, Project, Snippet } from "./transport";

type Kind = "profiles" | "accounts" | "hosts" | "projects" | "snippets";
type Item = Profile | Account | Host | Project | Snippet;

interface Spec {
  title: string;
  blurb: string;
  singular: string;
  create(config: Config): Item;
  /** What the row under the name shows. */
  subtitle(item: Item, config: Config): string;
  color(item: Item): string | null;
  /** null = deletable; a string explains why not. */
  locked?(item: Item, config: Config): string | null;
  form(item: Item, ctx: Ctx, rerender: () => void): HTMLElement[];
}

const id = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

const SPECS: Record<Kind, Spec> = {
  profiles: {
    title: "Profiles",
    blurb: "The shells the + Tab menu offers. Each one can start in its own folder with its own environment.",
    singular: "profile",
    create: () => ({ id: id("p"), name: "New profile", exe: "pwsh.exe", args: [], cwd: null, env: {} }) as Profile,
    subtitle: (item) => (item as Profile).exe,
    color: () => null,
    locked: (_item, config) => (config.profiles.length === 1 ? "The last profile cannot be deleted — the app needs a shell to start." : null),
    form: (item, ctx, rerender) => {
      const p = item as Profile;
      return [
        grid(
          field("Name", text(p.name, (v) => { p.name = v; ctx.save(); rerender(); }, { placeholder: "PowerShell 7" })),
          field("Executable", text(p.exe, (v) => { p.exe = v; ctx.save(); rerender(); }, { placeholder: "pwsh.exe" })),
          field("Arguments", text(p.args.join(" "), (v) => { p.args = v.split(/\s+/).filter(Boolean); ctx.save(); }, { placeholder: "-NoLogo" })),
          field("Start in", text(p.cwd ?? "", (v) => { p.cwd = v || null; ctx.save(); }, { placeholder: "the default folder" })),
        ),
        grid(
          field("Capture to a log automatically", toggle(p.capture ?? false, (v) => { p.capture = v; ctx.save(); })),
          field("", staticText("Every shell on this profile starts recording; Ctrl+Shift+L still toggles it.")),
        ),
        envCard(p.env ?? (p.env = {}), ctx, "Environment for this shell"),
        note(`Opened by Ctrl+Shift+${(ctx.config.profiles.indexOf(p) + 1) || 1}, or from the + Tab menu.`),
      ];
    },
  },

  accounts: {
    title: "Accounts",
    blurb:
      "An account is the environment new shells start with. OBPTerm never reads or writes a credential — it points Claude Code, Azure or AWS at the right folder and lets them do that.",
    singular: "account",
    create: (config) => ({
      id: id("a"),
      name: "New account",
      env: { CLAUDE_CONFIG_DIR: "%USERPROFILE%\\.claude-work" },
      claude_dir: "%USERPROFILE%\\.claude-work",
      color: COLORS[config.accounts.length % COLORS.length]!,
    }) as Account,
    subtitle: (item) => (item as Account).claude_dir ?? "no Claude folder",
    color: (item) => (item as Account).color,
    form: (item, ctx, rerender) => {
      const a = item as Account;
      const isDefault = ctx.config.default_account === a.id;
      return [
        grid(
          field("Name", text(a.name, (v) => { a.name = v; ctx.save(); rerender(); })),
          field("Colour", swatches(a.color, (v) => { a.color = v; ctx.save(); rerender(); })),
          field("Default for new shells", toggle(isDefault, (v) => {
            ctx.config.default_account = v ? a.id : null;
            ctx.save();
            rerender();
          })),
          field("Claude config folder", text(a.claude_dir ?? "", (v) => {
            a.claude_dir = v || null;
            // The meters read claude_dir and the shells read env.CLAUDE_CONFIG_DIR: typing the
            // folder in one place and not the other pointed them at different logins.
            if (v || a.env.CLAUDE_CONFIG_DIR !== undefined) a.env.CLAUDE_CONFIG_DIR = v;
            ctx.save();
            rerender();
          }, { placeholder: "%USERPROFILE%\\.claude" })),
        ),
        envCard(a.env ?? (a.env = {}), ctx, "Environment for new shells"),
        actions(
          button("Open a tab", () => ctx.newTab(a)),
          button("Sign in", () => ctx.signIn(a), "primary"),
        ),
        note("Environment reaches a process when it starts, so this applies to new tabs and panes, never to a shell already running."),
      ];
    },
  },

  hosts: {
    title: "SSH hosts",
    blurb: "Targets for Ctrl+Shift+H and the status bar's host chip. A host tab is a shell running ssh.",
    singular: "host",
    create: () => ({ id: id("h"), name: "New host", host: "", user: null, port: null, identity: null, project: null }) as Host,
    subtitle: (item) => {
      const h = item as Host;
      return h.user ? `${h.user}@${h.host}` : h.host || "no address";
    },
    color: () => null,
    form: (item, ctx, rerender) => {
      const h = item as Host;
      return [
        grid(
          field("Name", text(h.name, (v) => { h.name = v; ctx.save(); rerender(); })),
          field("Host", text(h.host, (v) => { h.host = v; ctx.save(); rerender(); }, { placeholder: "vps.example.com" })),
          field("User", text(h.user ?? "", (v) => { h.user = v || null; ctx.save(); rerender(); })),
          field("Port", number(h.port, (v) => { h.port = v; ctx.save(); }, { placeholder: "22", width: 120 })),
          field("Key file", text(h.identity ?? "", (v) => { h.identity = v || null; ctx.save(); }, { placeholder: "%USERPROFILE%\\.ssh\\id_ed25519" })),
          field("Open in project", select(
            [{ value: "", label: "—" }, ...ctx.config.projects.map((p) => ({ value: p.id, label: p.name }))],
            h.project ?? "",
            (v) => { h.project = v || null; ctx.save(); },
          )),
        ),
      ];
    },
  },

  snippets: {
    title: "Snippets",
    blurb: "Commands you keep retyping. They show up in the command palette (Ctrl+K) and type into the focused pane.",
    singular: "snippet",
    create: () => ({ id: id("s"), name: "New snippet", text: "", send: false }) as Snippet,
    subtitle: (item) => (item as Snippet).text || "empty",
    color: () => null,
    form: (item, ctx, rerender) => {
      const s = item as Snippet;
      return [
        grid(
          field("Name", text(s.name, (v) => { s.name = v; ctx.save(); rerender(); })),
          field("Press Enter for me", toggle(s.send, (v) => { s.send = v; ctx.save(); })),
          field("Command", text(s.text, (v) => { s.text = v; ctx.save(); rerender(); }, { placeholder: "docker compose ps" }), true),
        ),
        note("Nothing is sent until you pick it from the palette, and it goes to the focused pane only."),
      ];
    },
  },

  projects: {
    title: "Projects",
    blurb: "Tab groups in the rail. Each one has a colour, can start in its own folder and can remember a set of tabs.",
    singular: "project",
    create: (config) => ({
      id: id("pr"),
      name: "New project",
      color: COLORS[config.projects.length % COLORS.length]!,
      cwd: null,
      default_profile: null,
      layout: null,
      collapsed: false,
    }) as Project,
    subtitle: (item) => {
      const p = item as Project;
      const tabs = Array.isArray(p.layout) ? p.layout.length : 0;
      return tabs ? `${tabs} tab${tabs > 1 ? "s" : ""} saved` : "no saved layout";
    },
    color: (item) => (item as Project).color,
    form: (item, ctx, rerender) => {
      const p = item as Project;
      return [
        grid(
          field("Name", text(p.name, (v) => { p.name = v; ctx.save(); rerender(); })),
          field("Colour", swatches(p.color, (v) => { p.color = v ?? COLORS[0]!; ctx.save(); rerender(); }, false)),
          field("Start in", text(p.cwd ?? "", (v) => { p.cwd = v || null; ctx.save(); }, { placeholder: "the default folder" })),
          field("Default profile", select(
            [{ value: "", label: "—" }, ...ctx.config.profiles.map((x) => ({ value: x.id, label: x.name }))],
            p.default_profile ?? "",
            (v) => { p.default_profile = v || null; ctx.save(); },
          )),
          field("Collapsed in the rail", toggle(p.collapsed, (v) => { p.collapsed = v; ctx.save(); })),
          field("Saved layout", Array.isArray(p.layout) && p.layout.length
            ? button("Forget layout", () => { p.layout = null; ctx.save(); rerender(); }, "danger")
            : staticText("Save one from the project's menu in the rail.")),
        ),
      ];
    },
  },
};

export function renderList(ctx: Ctx, kind: Kind): HTMLElement {
  const spec = SPECS[kind];
  const wrap = document.createElement("div");
  wrap.className = "sw-split";
  let selected = 0;

  const draw = () => {
    const items = ctx.config[kind] as unknown as Item[];
    if (selected >= items.length) selected = Math.max(0, items.length - 1);

    const list = document.createElement("div");
    list.className = "sw-list";
    const capEl = document.createElement("div");
    capEl.className = "cap";
    capEl.textContent = `${items.length} ${items.length === 1 ? spec.singular : spec.title.toLowerCase()}`;
    list.appendChild(capEl);

    items.forEach((item, i) => {
      const b = document.createElement("button");
      b.className = `sw-item${i === selected ? " on" : ""}`;
      const color = spec.color(item);
      if (color) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = color;
        b.appendChild(dot);
      }
      const who = document.createElement("span");
      who.className = "who";
      const name = document.createElement("b");
      name.textContent = (item as { name: string }).name;
      const sub = document.createElement("span");
      sub.textContent = spec.subtitle(item, ctx.config);
      who.append(name, sub);
      b.appendChild(who);
      if (kind === "accounts" && ctx.config.default_account === (item as Account).id) {
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.textContent = "default";
        b.appendChild(flag);
      }
      if (kind === "profiles" && ctx.config.default_profile === (item as Profile).id) {
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.textContent = "default";
        b.appendChild(flag);
      }
      b.onclick = () => {
        selected = i;
        draw();
      };
      list.appendChild(b);
    });

    const add = document.createElement("button");
    add.className = "sw-add";
    add.textContent = `+ Add ${spec.singular}`;
    add.onclick = () => {
      items.push(spec.create(ctx.config));
      selected = items.length - 1;
      ctx.save();
      ctx.rerender();
    };
    list.appendChild(add);

    const detail = document.createElement("div");
    detail.className = "sw-detail";
    const item = items[selected];
    if (!item) {
      detail.append(headBlock(spec.title, spec.blurb), note(`Nothing here yet — add a ${spec.singular}.`));
    } else {
      const heading = document.createElement("div");
      heading.style.display = "flex";
      heading.style.alignItems = "flex-start";
      heading.style.gap = "16px";
      heading.style.marginBottom = "16px";
      const left = headBlock((item as { name: string }).name, spec.blurb);
      left.style.flex = "1";
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.append(
        button("Duplicate", () => {
          const copy = JSON.parse(JSON.stringify(item)) as { id: string; name: string };
          copy.id = id(kind[0]!);
          copy.name = `${copy.name} copy`;
          items.splice(selected + 1, 0, copy as unknown as Item);
          selected += 1;
          ctx.save();
          ctx.rerender();
        }),
        deleteButton(ctx, kind, spec, item, () => {
          ctx.save();
          ctx.rerender();
        }),
      );
      heading.append(left, actions);
      detail.append(heading, ...spec.form(item, ctx, () => draw()));
    }

    wrap.replaceChildren(list, detail);
  };

  draw();
  return wrap;
}

function deleteButton(ctx: Ctx, kind: Kind, spec: Spec, item: Item, done: () => void): HTMLButtonElement {
  const items = ctx.config[kind] as unknown as Item[];
  const locked = spec.locked?.(item, ctx.config) ?? null;
  const b = button("Delete", () => {
    const index = items.indexOf(item);
    items.splice(index, 1);
    // Anything pointing at it stops pointing at it.
    if (kind === "accounts" && ctx.config.default_account === (item as Account).id) ctx.config.default_account = null;
    if (kind === "profiles" && ctx.config.default_profile === (item as Profile).id) {
      ctx.config.default_profile = ctx.config.profiles[0]?.id ?? "";
    }
    done();
    toast(`Deleted “${(item as { name: string }).name}”`, {
      label: "Undo",
      run: () => {
        items.splice(index, 0, item);
        done();
      },
    });
  }, "danger");
  if (locked) {
    b.disabled = true;
    b.title = locked;
  }
  return b;
}

function headBlock(title: string, blurb: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-head-block";
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = blurb;
  el.append(h, p);
  return el;
}

/** A row of buttons under a card. */
function actions(...buttons: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.style.display = "flex";
  el.style.gap = "8px";
  el.style.margin = "-4px 0 16px";
  el.append(...buttons);
  return el;
}

function grid(...fields: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "sw-card";
  const g = document.createElement("div");
  g.className = "sw-grid";
  g.append(...fields);
  el.appendChild(g);
  return el;
}

function field(label: string, control: HTMLElement, wide = false): HTMLElement {
  const el = document.createElement("div");
  el.className = `sw-field${wide ? " wide" : ""}`;
  const l = document.createElement("label");
  l.textContent = label;
  el.append(l, control);
  return el;
}

function staticText(value: string): HTMLElement {
  const el = document.createElement("div");
  el.style.font = "12px var(--sans)";
  el.style.color = "var(--muted)";
  el.style.padding = "8px 0";
  el.textContent = value;
  return el;
}

/** KEY=value pairs, with a blank row that turns into a new pair when you fill it in. */
function envCard(env: Record<string, string>, ctx: Ctx, title: string): HTMLElement {
  const el = card();
  const capEl = document.createElement("div");
  capEl.className = "sw-cap";
  capEl.style.padding = "14px 18px 6px";
  capEl.textContent = title;
  const list = document.createElement("div");
  list.className = "sw-kv";

  const draw = () => {
    list.replaceChildren();
    for (const [key, value] of Object.entries(env)) {
      const pair = document.createElement("div");
      pair.className = "pair";
      const k = text(key, (v) => {
        delete env[key];
        if (v) env[v] = value;
        ctx.save();
        draw();
      });
      k.className = "sw-input k";
      const v = text(value, (nv) => {
        env[key] = nv;
        ctx.save();
      });
      v.className = "sw-input v";
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = `Remove ${key}`;
      x.onclick = () => {
        delete env[key];
        ctx.save();
        draw();
      };
      pair.append(k, v, x);
      list.appendChild(pair);
    }
    const pair = document.createElement("div");
    pair.className = "pair";
    const k = text("", (v) => {
      if (!v) return;
      env[v] = "";
      ctx.save();
      draw();
    }, { placeholder: "NEW_KEY" });
    k.className = "sw-input k";
    const v = text("", () => {}, { placeholder: "value" });
    v.className = "sw-input v";
    v.disabled = true;
    pair.append(k, v);
    list.appendChild(pair);
  };
  draw();
  el.append(capEl, list);
  return el;
}
