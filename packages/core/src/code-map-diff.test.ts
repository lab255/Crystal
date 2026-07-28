import { describe, expect, it } from "vitest";
import { diffCodeMaps, diffModuleFiles } from "./code-map-diff.js";
import type { CodeMapSummary, CodeModuleDetail } from "./codemap.js";

const summary = (
  modules: [path: string, fileCount: number][],
  deps: [source: string, target: string, weight: number][] = [],
): CodeMapSummary => ({
  modules: modules.map(([path, fileCount]) => ({ path, name: path, fileCount })),
  deps: deps.map(([source, target, weight]) => ({ source, target, weight })),
  fileTotal: modules.reduce((n, [, c]) => n + c, 0),
  generatedAt: "2026-01-01T00:00:00.000Z",
});

describe("diffCodeMaps", () => {
  it("marks module adds/removes/growth with scene ids and merges ghosts", () => {
    const base = summary([
      ["packages/core", 10],
      ["packages/old", 4],
    ]);
    const head = summary([
      ["packages/core", 12],
      ["packages/new", 3],
    ]);
    const { summary: merged, marks, counts } = diffCodeMaps(base, head);
    expect(merged.modules.map((m) => m.path)).toEqual([
      "packages/core",
      "packages/new",
      "packages/old", // ghost, appended
    ]);
    expect(marks["m:packages/new"]).toEqual({ kind: "added" });
    expect(marks["m:packages/old"]).toEqual({ kind: "removed", ghost: true });
    expect(marks["m:packages/core"]).toEqual({ kind: "changed", detail: "10 → 12 files" });
    expect(counts).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it("marks dep edges by weight shift and ghosts removed edges", () => {
    const base = summary(
      [
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ],
      [
        ["a", "b", 3],
        ["a", "c", 1],
      ],
    );
    const head = summary(
      [
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ],
      [["a", "b", 7]],
    );
    const { summary: merged, marks } = diffCodeMaps(base, head);
    expect(marks["dep:a->b"]).toEqual({ kind: "changed", detail: "3 → 7 imports" });
    expect(marks["dep:a->c"]).toEqual({ kind: "removed", ghost: true });
    expect(merged.deps).toHaveLength(2);
  });

  it("maps file statuses onto marks and rolls counts into module 'changed'", () => {
    const base = summary([["packages/core", 10]]);
    const head = summary([["packages/core", 10]]);
    const { marks } = diffCodeMaps(base, head, {
      changedFiles: [
        { path: "packages/core/src/a.ts", status: "modified" },
        { path: "packages/core/src/b.ts", status: "added" },
        { path: "packages/core/src/gone.ts", status: "deleted" },
      ],
    });
    expect(marks["f:packages/core/src/a.ts"]).toEqual({ kind: "changed" });
    expect(marks["f:packages/core/src/b.ts"]).toEqual({ kind: "added" });
    expect(marks["f:packages/core/src/gone.ts"]).toEqual({ kind: "removed", ghost: true });
    expect(marks["m:packages/core"]).toEqual({ kind: "changed", detail: "3 files changed" });
  });

  it("changed files never downgrade an added/removed module mark", () => {
    const base = summary([]);
    const head = summary([["packages/new", 2]]);
    const { marks } = diffCodeMaps(base, head, {
      changedFiles: [{ path: "packages/new/src/index.ts", status: "added" }],
    });
    expect(marks["m:packages/new"]).toEqual({ kind: "added" });
  });

  it("attributes changed files to the deepest owning module", () => {
    const base = summary([
      [".", 5],
      ["packages/core", 10],
    ]);
    const head = summary([
      [".", 5],
      ["packages/core", 10],
    ]);
    const { marks } = diffCodeMaps(base, head, {
      changedFiles: [
        { path: "packages/core/src/x.ts", status: "modified" },
        { path: "scripts/build.mjs", status: "modified" },
      ],
    });
    expect(marks["m:packages/core"]).toEqual({ kind: "changed", detail: "1 file changed" });
    expect(marks["m:."]).toEqual({ kind: "changed", detail: "1 file changed" });
  });
});

describe("diffModuleFiles", () => {
  const detail = (
    files: string[],
    edges: [string, string][] = [],
  ): CodeModuleDetail => ({
    module: { path: "packages/core", name: "core", fileCount: files.length },
    files: files.map((path) => ({
      path,
      name: path.split("/").pop() ?? path,
      dir: "",
      importCount: 0,
      exportCount: 0,
    })),
    edges: edges.map(([source, target]) => ({ source, target })),
    moduleDeps: [],
    truncated: false,
  });

  it("ghosts removed files and keeps base edges only when they touch a ghost", () => {
    const base = detail(
      ["src/a.ts", "src/gone.ts", "src/b.ts"],
      [
        ["src/a.ts", "src/gone.ts"], // touches ghost — kept
        ["src/a.ts", "src/b.ts"], // both survive but edge dropped at head — noise, dropped
      ],
    );
    const head = detail(["src/a.ts", "src/b.ts", "src/new.ts"], []);
    const { files, edges, marks } = diffModuleFiles(base, head, [
      { path: "src/b.ts", status: "modified" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/new.ts", "src/gone.ts"]);
    expect(marks["f:src/new.ts"]).toEqual({ kind: "added" });
    expect(marks["f:src/gone.ts"]).toEqual({ kind: "removed", ghost: true });
    expect(marks["f:src/b.ts"]).toEqual({ kind: "changed" });
    expect(edges).toEqual([{ source: "src/a.ts", target: "src/gone.ts" }]);
  });

  it("null base means everything is added (module itself is new)", () => {
    const head = detail(["src/a.ts"]);
    const { marks } = diffModuleFiles(null, head);
    expect(marks["f:src/a.ts"]).toEqual({ kind: "added" });
  });
});
