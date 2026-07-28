import { describe, expect, it } from "vitest";
import { countMarks, formatDiffCounts, mergeGhosts } from "./diagram-diff.js";

interface Item {
  id: string;
  value: number;
}

const item = (id: string, value = 0): Item => ({ id, value });
const byId = (i: Item) => i.id;

describe("mergeGhosts", () => {
  it("marks head-only items added and appends base-only items as removed ghosts", () => {
    const base = [item("a"), item("b")];
    const head = [item("b"), item("c")];
    const { items, marks } = mergeGhosts(base, head, byId);
    // Head order first, ghosts appended in base order.
    expect(items.map(byId)).toEqual(["b", "c", "a"]);
    expect(marks).toEqual({
      c: { kind: "added" },
      a: { kind: "removed", ghost: true },
    });
  });

  it("marks survivors changed via the comparator, string result becoming detail", () => {
    const base = [item("a", 1), item("b", 2), item("c", 3)];
    const head = [item("a", 1), item("b", 5), item("c", 9)];
    const { marks } = mergeGhosts(base, head, byId, (before, after) =>
      before.value === after.value ? false : before.value + " → " + after.value,
    );
    expect(marks).toEqual({
      b: { kind: "changed", detail: "2 → 5" },
      c: { kind: "changed", detail: "3 → 9" },
    });
  });

  it("a boolean-true comparator marks changed without detail", () => {
    const { marks } = mergeGhosts([item("a", 1)], [item("a", 2)], byId, () => true);
    expect(marks).toEqual({ a: { kind: "changed" } });
  });

  it("identical sides produce no marks and preserve head order", () => {
    const side = [item("x"), item("y")];
    const { items, marks } = mergeGhosts(side, side, byId, () => false);
    expect(items.map(byId)).toEqual(["x", "y"]);
    expect(marks).toEqual({});
  });

  it("empty base marks everything added; empty head ghosts everything", () => {
    expect(mergeGhosts([], [item("a")], byId).marks).toEqual({ a: { kind: "added" } });
    const gone = mergeGhosts([item("a")], [], byId);
    expect(gone.items.map(byId)).toEqual(["a"]);
    expect(gone.marks).toEqual({ a: { kind: "removed", ghost: true } });
  });
});

describe("countMarks / formatDiffCounts", () => {
  it("tallies per kind and formats compactly", () => {
    const { marks } = mergeGhosts(
      [item("a", 1), item("b")],
      [item("a", 2), item("c"), item("d")],
      byId,
      (x, y) => x.value !== y.value,
    );
    const counts = countMarks(marks);
    expect(counts).toEqual({ added: 2, removed: 1, changed: 1 });
    expect(formatDiffCounts(counts)).toBe("+2 −1 ~1");
    expect(formatDiffCounts({ added: 0, removed: 0, changed: 0 })).toBe("");
  });
});
