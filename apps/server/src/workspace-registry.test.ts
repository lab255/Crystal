import { describe, expect, it } from "vitest";
import { packageNameOf, type CrossSurface } from "./code-map.js";
import { computeCrossEdges } from "./workspace-registry.js";

function surface(partial: Partial<CrossSurface>): CrossSurface {
  return { packages: new Map(), externalImports: [], fileTotal: 0, ...partial };
}

describe("packageNameOf", () => {
  it("handles scoped, subpath and bare specifiers", () => {
    expect(packageNameOf("@crystal/core")).toBe("@crystal/core");
    expect(packageNameOf("@crystal/core/bridge")).toBe("@crystal/core");
    expect(packageNameOf("react")).toBe("react");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
  });

  it("rejects relative and node builtins", () => {
    expect(packageNameOf("./util.js")).toBeNull();
    expect(packageNameOf("../x")).toBeNull();
    expect(packageNameOf("node:path")).toBeNull();
  });
});

describe("computeCrossEdges", () => {
  it("matches one workspace's external imports against another's packages", () => {
    const surfaces = new Map<string, CrossSurface>([
      [
        "wsA",
        surface({
          externalImports: [
            { fromModule: "apps/web", pkg: "@lib/ui", names: ["Button"] },
            { fromModule: "apps/web", pkg: "@lib/ui", names: ["Dialog", "Button"] },
            { fromModule: "apps/api", pkg: "@lib/ui", names: ["theme"] },
            { fromModule: "apps/web", pkg: "react", names: ["default"] },
          ],
        }),
      ],
      ["wsB", surface({ packages: new Map([["@lib/ui", "packages/ui"]]) })],
    ]);

    const edges = computeCrossEdges(surfaces);
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge).toMatchObject({ source: "wsA", target: "wsB", weight: 3 });
    expect(edge.packages).toHaveLength(1);
    expect(edge.packages[0]).toMatchObject({ pkg: "@lib/ui", toModule: "packages/ui", count: 3 });
    // Heaviest consumer first, names deduplicated.
    expect(edge.packages[0]!.uses[0]).toEqual({
      fromModule: "apps/web",
      count: 2,
      names: ["Button", "Dialog"],
    });
    expect(edge.packages[0]!.uses[1]).toEqual({ fromModule: "apps/api", count: 1, names: ["theme"] });
  });

  it("produces directed edges per pair and ignores self-imports", () => {
    const surfaces = new Map<string, CrossSurface>([
      [
        "wsA",
        surface({
          packages: new Map([["@a/kit", "packages/kit"]]),
          externalImports: [
            { fromModule: "src", pkg: "@b/sdk", names: [] },
            // A workspace importing its own package is not a cross edge.
            { fromModule: "src", pkg: "@a/kit", names: [] },
          ],
        }),
      ],
      [
        "wsB",
        surface({
          packages: new Map([["@b/sdk", "."]]),
          externalImports: [{ fromModule: ".", pkg: "@a/kit", names: ["make"] }],
        }),
      ],
    ]);

    const edges = computeCrossEdges(surfaces);
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(["wsA->wsB", "wsB->wsA"]);
    expect(edges.every((e) => e.weight === 1)).toBe(true);
  });

  it("returns no edges for unrelated workspaces", () => {
    const surfaces = new Map<string, CrossSurface>([
      ["wsA", surface({ externalImports: [{ fromModule: ".", pkg: "lodash", names: [] }] })],
      ["wsB", surface({ packages: new Map([["@b/sdk", "."]]) })],
    ]);
    expect(computeCrossEdges(surfaces)).toEqual([]);
  });
});
