// One popup for every menu in the app (profiles, tab, project, colours).
export interface MenuItem {
  label: string;
  hint?: string;
  swatch?: string;
  danger?: boolean;
  onPick: () => void;
}

const el = () => document.querySelector<HTMLElement>("#menu")!;

export function openMenu(x: number, y: number, items: MenuItem[]) {
  const menu = el();
  menu.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement("button");
      b.className = "menu-item" + (item.danger ? " danger" : "");
      if (item.swatch) {
        const dot = document.createElement("span");
        dot.className = "swatch";
        dot.style.background = item.swatch;
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(item.label));
      if (item.hint) {
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = item.hint;
        b.appendChild(k);
      }
      b.onclick = (e) => {
        e.stopPropagation();
        closeMenuNow();
        item.onPick();
      };
      return b;
    }),
  );
  menu.hidden = false;
  // The click that opened this menu is still travelling: `keys.ts` closes menus on any document
  // click, so without this the menu is built and hidden again in the same gesture — which looks
  // exactly like the chip doing nothing. Ignore document clicks until this one is over.
  openedAt = performance.now();
  // Place inside the viewport now that it has a size.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
}

/** When the current menu opened, so the opening click cannot also close it. */
let openedAt = 0;

export function closeMenu() {
  // A menu younger than one gesture is being closed by its own opening click.
  if (performance.now() - openedAt < 150) return;
  el().hidden = true;
}

/** Close regardless of age — what Escape and picking an item want. */
export function closeMenuNow() {
  openedAt = 0;
  el().hidden = true;
}

/** The 8 project/tab colours: the Sentinel accent plus the metric hues from DESIGN.md. */
export const COLORS = [
  { name: "Orange", value: "#ff8a1e" },
  { name: "Blue", value: "#4c8dff" },
  { name: "Green", value: "#2fd6a3" },
  { name: "Violet", value: "#b48cff" },
  { name: "Cyan", value: "#22d3ee" },
  { name: "Amber", value: "#ffb454" },
  { name: "Rose", value: "#ff6b73" },
  { name: "Slate", value: "#8b97a8" },
];
