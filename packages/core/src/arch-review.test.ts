import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";
import {
  applyCodeSnapshotToGraph,
  archKindForCodeModule,
  significantModules,
} from "./arch-review.js";
import type { CodeModule, CodeModuleDep } from "./codemap.js";

function moduleNode(id: string, codeModule: string, parentId: string | null = null): ArchNode {
  return {
    ...createArchNode("repo", id, { x: 0, y: 0 }, parentId),
    id,
    description: "3 files",
    codeModule,
  };
}

function mod(path: string, fileCount = 3, name = path): CodeModule {
  return { path, name, fileCount };
}

function graph(nodes: ArchNode[], edges: ArchEdge[] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), nodes, edges };
}

describe("archKindForCodeModule", () => {
  it("keeps the seed heuristic: apps split frontend/service, everything else repo", () => {
    expect(archKindForCodeModule(mod("apps/web", 1, "@x/web"))).toBe("frontend");
    expect(archKindForCodeModule(mod("apps/server", 1, "@x/server"))).toBe("service");
    expect(archKindForCodeModule(mod("packages/core", 1, "@x/core"))).toBe("repo");
  });
});

describe("significantModules", () => {
  it("drops empty modules and the root when submodules exist", () => {
    const kept = significantModules([mod(".", 2), mod("packages/a", 3), mod("packages/b", 0)]);
    expect(kept.map((m) => m.path)).toEqual(["packages/a"]);
  });

  it("keeps the root when it is the only module", () => {
    expect(significantModules([mod(".", 5)]).map((m) => m.path)).toEqual(["."]);
  });
});

describe("applyCodeSnapshotToGraph", () => {
  const deps: CodeModuleDep[] = [{ source: "packages/a", target: "packages/b", weight: 4 }];

  it("adds nodes for modules new at the ref, inside the matching group", () => {
    const grp = { ...createArchNode("group", "packages/", { x: 0, y: 0 }), id: "grp" };
    const g = graph([grp, moduleNode("a", "packages/a", "grp")]);
    const next = applyCodeSnapshotToGraph(g, {
      modules: [mod("packages/a"), mod("packages/b")],
      deps,
    });
    const added = next.nodes.find((n) => n.codeModule === "packages/b");
    expect(added).toBeTruthy();
    expect(added!.parentId).toBe("grp");
    expect(added!.description).toBe("3 files");
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ kind: "dependency", label: "×4" });
  });

  it("removes module nodes whose code is gone, with their edges", () => {
    const g = graph(
      [moduleNode("a", "packages/a"), moduleNode("b", "packages/b")],
      [{ id: "e1", source: "a", target: "b", kind: "dependency", label: "×4" }],
    );
    const next = applyCodeSnapshotToGraph(g, { modules: [mod("packages/a")], deps: [] });
    expect(next.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(next.edges).toEqual([]);
  });

  it("updates dependency weights but keeps surviving edge ids stable", () => {
    const g = graph(
      [moduleNode("a", "packages/a"), moduleNode("b", "packages/b")],
      [{ id: "e1", source: "a", target: "b", kind: "dependency", label: "×2" }],
    );
    const next = applyCodeSnapshotToGraph(g, {
      modules: [mod("packages/a"), mod("packages/b")],
      deps,
    });
    expect(next.edges).toEqual([
      { id: "e1", source: "a", target: "b", kind: "dependency", label: "×4" },
    ]);
  });

  it("never touches hand-drawn nodes or non-dependency edges", () => {
    const manual = { ...createArchNode("datastore", "postgres", { x: 0, y: 0 }), id: "db" };
    const syncEdge: ArchEdge = { id: "s1", source: "a", target: "db", kind: "sync", label: "reads" };
    const g = graph([moduleNode("a", "packages/a"), manual], [syncEdge]);
    const next = applyCodeSnapshotToGraph(g, { modules: [mod("packages/a")], deps: [] });
    expect(next.nodes.map((n) => n.id)).toEqual(["a", "db"]);
    expect(next.edges).toEqual([syncEdge]);
  });

  it("preserves hand-written descriptions while refreshing file counters", () => {
    const documented = { ...moduleNode("a", "packages/a"), description: "the domain model" };
    const counted = moduleNode("b", "packages/b");
    const g = graph([documented, counted]);
    const next = applyCodeSnapshotToGraph(g, {
      modules: [mod("packages/a", 9), mod("packages/b", 9)],
      deps: [],
    });
    expect(next.nodes.find((n) => n.id === "a")!.description).toBe("the domain model");
    expect(next.nodes.find((n) => n.id === "b")!.description).toBe("9 files");
  });
});
