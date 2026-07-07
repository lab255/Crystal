import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, CodeMapSummary } from "@crystal/core";
import { adoptAutoLinks, computeOverlay, suggestModuleFor } from "./overlay.js";

function graph(partial: Partial<ArchitectureGraph>): ArchitectureGraph {
  return {
    id: "arch_test",
    name: "Test",
    description: "",
    nodes: [],
    edges: [],
    environments: [],
    journeys: [],
    facets: [],
    ...partial,
  };
}

function node(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "service" as const,
    label,
    description: "",
    position: { x: 0, y: 0 },
    tech: [],
    placements: {},
    ...extra,
  };
}

const summary: CodeMapSummary = {
  modules: [
    { path: "packages/core", name: "@crystal/core", fileCount: 10 },
    { path: "packages/client", name: "@crystal/client", fileCount: 6 },
    { path: "apps/server", name: "@crystal/server", fileCount: 8 },
    { path: ".", name: "crystal", fileCount: 0 },
  ],
  deps: [
    { source: "packages/client", target: "packages/core", weight: 5 },
    { source: "apps/server", target: "packages/core", weight: 7 },
  ],
  fileTotal: 24,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("suggestModuleFor", () => {
  it("matches by module name ignoring scope, case and punctuation", () => {
    const match = suggestModuleFor(node("n1", "Core") as never, summary.modules);
    expect(match?.path).toBe("packages/core");
  });

  it("falls back to path basename", () => {
    const modules = [{ path: "apps/bridge-server", name: "something-else", fileCount: 3 }];
    const match = suggestModuleFor(node("n1", "Bridge Server") as never, modules);
    expect(match?.path).toBe("apps/bridge-server");
  });

  it("returns null when nothing matches", () => {
    expect(suggestModuleFor(node("n1", "Payments") as never, summary.modules)).toBeNull();
  });
});

describe("computeOverlay", () => {
  it("prefers explicit codeModule links over name matches", () => {
    const g = graph({
      nodes: [node("n1", "Totally Unrelated", { codeModule: "packages/core" })],
    });
    const overlay = computeOverlay(g, summary);
    expect(overlay.nodeBadges.get("n1")).toMatchObject({
      module: "packages/core",
      fileCount: 10,
      auto: false,
    });
  });

  it("auto-links by name and marks the link as auto", () => {
    const g = graph({ nodes: [node("n1", "client")] });
    const overlay = computeOverlay(g, summary);
    expect(overlay.nodeBadges.get("n1")).toMatchObject({ module: "packages/client", auto: true });
  });

  it("never auto-links one module to two nodes", () => {
    const g = graph({ nodes: [node("n1", "core"), node("n2", "Core")] });
    const overlay = computeOverlay(g, summary);
    const linked = [overlay.nodeBadges.get("n1"), overlay.nodeBadges.get("n2")].filter(Boolean);
    expect(linked).toHaveLength(1);
  });

  it("classifies edges: confirmed / stale / ghost", () => {
    const g = graph({
      nodes: [
        node("n1", "client", { codeModule: "packages/client" }),
        node("n2", "core", { codeModule: "packages/core" }),
        node("n3", "server", { codeModule: "apps/server" }),
      ],
      edges: [
        // Drawn opposite to the import direction — still confirmed.
        { id: "e1", source: "n2", target: "n1", kind: "sync", label: "" },
        // Drawn between linked nodes with no code dep — stale.
        { id: "e2", source: "n1", target: "n3", kind: "sync", label: "" },
      ],
    });
    const overlay = computeOverlay(g, summary);
    expect(overlay.confirmedEdgeIds.has("e1")).toBe(true);
    expect(overlay.staleEdgeIds.has("e2")).toBe(true);
    // server → core exists in code but not in the diagram.
    expect(overlay.ghostEdges).toEqual([
      {
        source: "n3",
        target: "n2",
        weight: 7,
        sourceModule: "apps/server",
        targetModule: "packages/core",
      },
    ]);
  });

  it("ignores edges touching unlinked nodes and notes", () => {
    const g = graph({
      nodes: [
        node("n1", "client", { codeModule: "packages/client" }),
        node("n2", "Mystery Box"),
        node("note1", "todo", { kind: "note" }),
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", kind: "sync", label: "" }],
    });
    const overlay = computeOverlay(g, summary);
    expect(overlay.confirmedEdgeIds.size).toBe(0);
    expect(overlay.staleEdgeIds.size).toBe(0);
    expect(overlay.nodeBadges.has("note1")).toBe(false);
  });

  it("reports modules with files that nothing links to", () => {
    const g = graph({ nodes: [node("n1", "core")] });
    const overlay = computeOverlay(g, summary);
    expect(overlay.unmappedModules.map((m) => m.path).sort()).toEqual([
      "apps/server",
      "packages/client",
    ]);
  });
});

describe("adoptAutoLinks", () => {
  it("persists auto matches as codeModule and leaves the rest alone", () => {
    const g = graph({
      nodes: [node("n1", "client"), node("n2", "core", { codeModule: "packages/core" })],
    });
    const overlay = computeOverlay(g, summary);
    const adopted = adoptAutoLinks(g, overlay);
    expect(adopted.nodes.find((n) => n.id === "n1")?.codeModule).toBe("packages/client");
    expect(adopted.nodes.find((n) => n.id === "n2")?.codeModule).toBe("packages/core");
    // Re-running the overlay on the adopted graph yields no auto links.
    const overlay2 = computeOverlay(adopted, summary);
    expect([...overlay2.nodeBadges.values()].every((b) => !b.auto)).toBe(true);
  });
});
