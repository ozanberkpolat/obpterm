// The pane tree of one tab. A leaf is a Pane; a split holds two children and the fraction of
// the box the first one gets. Small trees, so every operation just walks from the root.
import type { Pane } from "./pane";

export interface Leaf {
  kind: "leaf";
  pane: Pane;
}
export interface Split {
  kind: "split";
  /** "row" = side by side (a vertical divider), "col" = stacked. */
  dir: "row" | "col";
  ratio: number;
  a: Node;
  b: Node;
}
export type Node = Leaf | Split;

export interface SavedNode {
  kind: "leaf" | "split";
  profile?: string;
  cwd?: string | null;
  /** The host's id for this shell, so a restart reattaches instead of respawning. */
  pty?: number | null;
  dir?: "row" | "col";
  ratio?: number;
  a?: SavedNode;
  b?: SavedNode;
}

export const leaf = (pane: Pane): Leaf => ({ kind: "leaf", pane });

export function panes(node: Node): Pane[] {
  return node.kind === "leaf" ? [node.pane] : [...panes(node.a), ...panes(node.b)];
}

export function findLeaf(node: Node, pane: Pane): Leaf | null {
  if (node.kind === "leaf") return node.pane === pane ? node : null;
  return findLeaf(node.a, pane) ?? findLeaf(node.b, pane);
}

/** Splits `target` in two, `next` taking the second half. Returns the new root. */
export function split(root: Node, target: Pane, next: Pane, dir: "row" | "col"): Node {
  return map(root, target, (l) => ({ kind: "split", dir, ratio: 0.5, a: l, b: leaf(next) }));
}

/** Removes `target`; its sibling takes the whole box. `null` = the tab is now empty. */
export function remove(root: Node, target: Pane): Node | null {
  if (root.kind === "leaf") return root.pane === target ? null : root;
  const a = remove(root.a, target);
  const b = remove(root.b, target);
  if (!a) return b;
  if (!b) return a;
  return a === root.a && b === root.b ? root : { ...root, a, b };
}

function map(node: Node, target: Pane, fn: (l: Leaf) => Node): Node {
  if (node.kind === "leaf") return node.pane === target ? fn(node) : node;
  return { ...node, a: map(node.a, target, fn), b: map(node.b, target, fn) };
}

/** Splits from the root down to `target`, outermost first. */
export function ancestors(root: Node, target: Pane): Split[] {
  if (root.kind === "leaf") return [];
  const inA = findLeaf(root.a, target);
  const rest = ancestors(inA ? root.a : root.b, target);
  return findLeaf(root, target) ? [root, ...rest] : [];
}

/** Nudges the nearest enclosing split of the right direction. Returns true if one existed. */
export function nudge(root: Node, target: Pane, dir: "row" | "col", delta: number): boolean {
  const split = ancestors(root, target).reverse().find((s) => s.dir === dir);
  if (!split) return false;
  split.ratio = Math.min(0.9, Math.max(0.1, split.ratio + delta));
  return true;
}

/** Rebuilds `container` around the panes' existing elements. */
export function render(root: Node, container: HTMLElement, onRatioCommit: () => void) {
  const el = build(root, onRatioCommit);
  // The root fills the tab; whatever flex it carried as somebody's child is stale.
  el.style.flex = "";
  container.replaceChildren(el);
}

function build(node: Node, onRatioCommit: () => void): HTMLElement {
  if (node.kind === "leaf") {
    // A pane element outlives the tree it was in: closing its sibling must not leave it
    // sized for a split that no longer exists.
    node.pane.el.style.flex = "";
    return node.pane.el;
  }
  const el = document.createElement("div");
  el.className = `split ${node.dir}`;
  const a = build(node.a, onRatioCommit);
  const b = build(node.b, onRatioCommit);
  const divider = document.createElement("div");
  divider.className = "divider";
  divider.setAttribute("role", "separator");
  const apply = () => {
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
  };
  apply();
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    const box = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const f = node.dir === "row" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      node.ratio = Math.min(0.9, Math.max(0.1, f));
      apply();
    };
    const up = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      onRatioCommit();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
  el.append(a, divider, b);
  return el;
}

/** Nearest pane whose centre lies in `dir` from the focused one — geometry beats tree-walking. */
export function neighbour(root: Node, from: Pane, dir: "left" | "right" | "up" | "down"): Pane | null {
  const box = from.el.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let best: Pane | null = null;
  let bestDist = Infinity;
  for (const p of panes(root)) {
    if (p === from) continue;
    const r = p.el.getBoundingClientRect();
    const px = r.left + r.width / 2;
    const py = r.top + r.height / 2;
    const ok =
      dir === "left" ? r.right <= box.left + 1 : dir === "right" ? r.left >= box.right - 1 : dir === "up" ? r.bottom <= box.top + 1 : r.top >= box.bottom - 1;
    if (!ok) continue;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function serialize(node: Node): SavedNode {
  if (node.kind === "leaf") {
    return { kind: "leaf", profile: node.pane.profile.id, cwd: node.pane.cwd, pty: node.pane.id > 0 ? node.pane.id : null };
  }
  return { kind: "split", dir: node.dir, ratio: node.ratio, a: serialize(node.a), b: serialize(node.b) };
}
