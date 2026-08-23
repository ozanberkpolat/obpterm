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
        closeMenu();
        item.onPick();
      };
      return b;
    }),
  );
  menu.hidden = false;
  // Place inside the viewport now that it has a size.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
}

export function closeMenu() {
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
