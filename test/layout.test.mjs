// Pane-tree maths, the one piece of obpterm with logic worth breaking.
// Run: npm test  (esbuild strips the types, node:test runs it — no DOM needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../dist-test/layout.js";

const pane = (id) => ({ id, profile: { id: `p${id}` }, cwd: `/w/${id}` });

test("split, remove and serialize round-trip", () => {
  const a = pane(1), b = pane(2), c = pane(3);
  let root = L.leaf(a);
  root = L.split(root, a, b, "row");
  root = L.split(root, b, c, "col");
  assert.deepEqual(L.panes(root).map((p) => p.id), [1, 2, 3]);

  const saved = L.serialize(root);
  assert.equal(saved.kind, "split");
  assert.equal(saved.a.profile, "p1");
  assert.equal(saved.b.dir, "col");
  assert.equal(saved.b.b.cwd, "/w/3");

  // Removing a leaf promotes its sibling; removing the last one empties the tab.
  root = L.remove(root, b);
  assert.deepEqual(L.panes(root).map((p) => p.id), [1, 3]);
  assert.equal(L.panes(L.remove(root, a)).length, 1);
  assert.equal(L.remove(L.leaf(a), a), null);
});

test("nudge finds the nearest split of the right axis and clamps", () => {
  const a = pane(1), b = pane(2);
  const root = L.split(L.leaf(a), a, b, "row");
  assert.equal(L.nudge(root, a, "col", 0.1), false, "no stacked split exists");
  assert.equal(L.nudge(root, a, "row", 0.2), true);
  assert.equal(root.ratio.toFixed(2), "0.70");
  for (let i = 0; i < 20; i++) L.nudge(root, a, "row", 0.2);
  assert.equal(root.ratio, 0.9, "ratio never leaves 0.1..0.9");
});

test("ancestors are outermost-first and only cover the path to the pane", () => {
  const a = pane(1), b = pane(2), c = pane(3);
  let root = L.split(L.leaf(a), a, b, "row");
  root = L.split(root, b, c, "col");
  assert.deepEqual(L.ancestors(root, c).map((s) => s.dir), ["row", "col"]);
  assert.deepEqual(L.ancestors(root, a).map((s) => s.dir), ["row"]);
});
