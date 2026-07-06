import { describe, expect, it } from "vitest";
import {
  createArchitectureGraph,
  isContainerKind,
  type CodeMapSummary,
} from "@crystal/core";
import { canSeedFromCodeMap, seedFromCodeMap } from "./seed.js";

const summary: CodeMapSummary = {
  modules: [
    { path: ".", name: "crystal", fileCount: 3 },
    { path: "apps/web", name: "@crystal/web", fileCount: 12 },
    { path: "apps/server", name: "@crystal/server", fileCount: 20 },
    { path: "packages/core", name: "@crystal/core", fileCount: 15 },
    { path: "packages/client", name: "@crystal/client", fileCount: 8 },
    { path: "tools", name: "tools", fileCount: 0 },
  ],
  deps: [
    { source: "apps/web", target: "packages/client", weight: 9 },
    { source: "apps/server", target: "packages/core", weight: 14 },
    { source: "packages/client", target: "packages/core", weight: 5 },
    { source: "tools", target: "packages/core", weight: 1 }, // dropped: 0-file module
  ],
  fileTotal: 58,
  generatedAt: "2026-07-06T00:00:00.000Z",
};

describe("seedFromCodeMap", () => {
  const base = createArchitectureGraph("Seeded");
  const graph = seedFromCodeMap(base, summary);

  it("keeps the base identity and environments", () => {
    expect(graph.id).toBe(base.id);
    expect(graph.name).toBe("Seeded");
    expect(graph.environments).toEqual(base.environments);
  });

  it("creates one linked leaf per module, skipping the root and empty modules", () => {
    const linked = graph.nodes.filter((n) => n.codeModule);
    expect(linked.map((n) => n.codeModule).sort()).toEqual([
      "apps/server",
      "apps/web",
      "packages/client",
      "packages/core",
    ]);
    const web = linked.find((n) => n.codeModule === "apps/web")!;
    expect(web.label).toBe("@crystal/web");
    expect(web.kind).toBe("frontend");
    expect(web.description).toBe("12 files");
    expect(linked.find((n) => n.codeModule === "apps/server")!.kind).toBe("service");
    expect(linked.find((n) => n.codeModule === "packages/core")!.kind).toBe("repo");
  });

  it("groups modules by top-level directory", () => {
    const groups = graph.nodes.filter((n) => isContainerKind(n.kind));
    expect(groups.map((g) => g.label).sort()).toEqual(["apps/", "packages/"]);
    const apps = groups.find((g) => g.label === "apps/")!;
    const members = graph.nodes.filter((n) => n.parentId === apps.id);
    expect(members.map((n) => n.codeModule).sort()).toEqual(["apps/server", "apps/web"]);
  });

  it("maps module deps to dependency edges with weight labels", () => {
    expect(graph.edges).toHaveLength(3); // the 0-file endpoint dep is dropped
    const byModule = new Map(graph.nodes.map((n) => [n.codeModule, n.id]));
    const edge = graph.edges.find((e) => e.source === byModule.get("apps/web"));
    expect(edge).toMatchObject({ target: byModule.get("packages/client"), kind: "dependency", label: "×9" });
  });

  it("orders parents before children", () => {
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    for (const n of graph.nodes) {
      if (n.parentId) expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!);
    }
  });

  it("lays out finite positions and fits containers around children", () => {
    for (const n of graph.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    for (const group of graph.nodes.filter((n) => isContainerKind(n.kind))) {
      const size = group.size!;
      for (const child of graph.nodes.filter((n) => n.parentId === group.id)) {
        expect(child.position.x).toBeGreaterThanOrEqual(0);
        expect(child.position.y).toBeGreaterThanOrEqual(0);
        expect(child.position.x + 200).toBeLessThanOrEqual(size.width);
        expect(child.position.y + 84).toBeLessThanOrEqual(size.height);
      }
    }
  });
});

describe("canSeedFromCodeMap", () => {
  it("requires at least two non-empty modules", () => {
    expect(canSeedFromCodeMap(null)).toBe(false);
    expect(canSeedFromCodeMap(summary)).toBe(true);
    expect(
      canSeedFromCodeMap({ ...summary, modules: [{ path: ".", name: "solo", fileCount: 4 }] }),
    ).toBe(false);
  });
});
