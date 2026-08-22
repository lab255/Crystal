import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchitectureGraph,
  type CodeMapSummary,
} from "@crystal/core";
import { detectedExternals, detectedInternalEdges, externalNodeId } from "./infra-deps.js";

function node(
  id: string,
  codeModule: string | null,
  placements: ArchNode["placements"] = {},
): ArchNode {
  return { ...createArchNode("service", id, { x: 0, y: 0 }), id, codeModule, placements };
}

function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), nodes, edges };
}

function summary(partial: Partial<CodeMapSummary>): CodeMapSummary {
  return { modules: [], deps: [], fileTotal: 0, generatedAt: "", ...partial };
}

const prod = { prod: { targetId: "tgt_ecs", target: "ecs", runtime: "" } };

describe("detectedInternalEdges", () => {
  it("maps module deps onto placed components", () => {
    const g = graph([node("api", "apps/api", prod), node("core", "packages/core", prod)]);
    const edges = detectedInternalEdges(
      g,
      "prod",
      summary({ deps: [{ source: "apps/api", target: "packages/core", weight: 7 }] }),
    );
    expect(edges).toEqual([{ source: "api", target: "core", weight: 7 }]);
  });

  it("skips unplaced endpoints and pairs the user already drew", () => {
    const g = graph(
      [node("api", "apps/api", prod), node("core", "packages/core", prod), node("cli", "apps/cli")],
      [{ id: "e1", source: "api", target: "core", kind: "sync", label: "" }],
    );
    const edges = detectedInternalEdges(
      g,
      "prod",
      summary({
        deps: [
          { source: "apps/api", target: "packages/core", weight: 7 }, // drawn already
          { source: "apps/cli", target: "packages/core", weight: 2 }, // cli unplaced
        ],
      }),
    );
    expect(edges).toEqual([]);
  });
});

describe("detectedExternals", () => {
  const postgres = {
    id: "postgres",
    name: "PostgreSQL",
    category: "database" as const,
    packages: ["pg"],
    clients: [
      { module: "apps/api", weight: 3 },
      { module: "apps/cli", weight: 1 },
    ],
    weight: 4,
  };

  it("attaches services to placed clients only", () => {
    const g = graph([node("api", "apps/api", prod), node("cli", "apps/cli")]);
    const externals = detectedExternals(g, "prod", summary({ externals: [postgres] }));
    expect(externals).toHaveLength(1);
    expect(externals[0]!.clients).toEqual([{ nodeId: "api", weight: 3 }]);
    expect(externalNodeId(externals[0]!.dep)).toBe("ext:postgres");
  });

  it("drops services whose clients are all unplaced", () => {
    const g = graph([node("cli", "apps/cli")]);
    expect(detectedExternals(g, "prod", summary({ externals: [postgres] }))).toEqual([]);
  });

  it("handles summaries without externals", () => {
    const g = graph([node("api", "apps/api", prod)]);
    expect(detectedExternals(g, "prod", summary({}))).toEqual([]);
  });
});
