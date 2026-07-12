import { describe, expect, it } from "vitest";
import { createArchitectureGraph, type CodeMapSummary } from "@crystal/core";
import { detectDrift, driftSignature, isCodeMapped } from "./auto-map.js";
import { seedFromCodeMap } from "./seed.js";

const summary: CodeMapSummary = {
  modules: [
    { path: "packages/core", name: "@crystal/core", fileCount: 15 },
    { path: "packages/client", name: "@crystal/client", fileCount: 8 },
    { path: "apps/web", name: "@crystal/web", fileCount: 12 },
  ],
  deps: [
    { source: "apps/web", target: "packages/client", weight: 9 },
    { source: "packages/client", target: "packages/core", weight: 5 },
  ],
  fileTotal: 35,
  generatedAt: "2026-07-12T00:00:00.000Z",
};

const seeded = () => seedFromCodeMap(createArchitectureGraph("Overview"), summary);

describe("isCodeMapped", () => {
  it("is true for a seeded diagram and false for a hand-drawn or empty one", () => {
    expect(isCodeMapped(seeded())).toBe(true);
    expect(isCodeMapped(createArchitectureGraph("Blank"))).toBe(false);
  });
});

describe("detectDrift", () => {
  it("reports nothing when the diagram matches the code", () => {
    expect(detectDrift(seeded(), summary)).toBeNull();
  });

  it("ignores hand-drawn diagrams and unusable summaries", () => {
    expect(detectDrift(createArchitectureGraph("Blank"), summary)).toBeNull();
    expect(detectDrift(seeded(), null)).toBeNull();
    // A single-module summary is below the seeding bar — too thin to trust.
    expect(
      detectDrift(seeded(), {
        ...summary,
        modules: [{ path: ".", name: "solo", fileCount: 4 }],
      }),
    ).toBeNull();
  });

  it("detects a new module and its dependency", () => {
    const grown: CodeMapSummary = {
      ...summary,
      modules: [...summary.modules, { path: "packages/editor", name: "@crystal/editor", fileCount: 6 }],
      deps: [...summary.deps, { source: "packages/editor", target: "packages/core", weight: 2 }],
    };
    const drift = detectDrift(seeded(), grown);
    expect(drift).not.toBeNull();
    expect(drift!.total).toBe(2);
    expect(drift!.diff.addedNodes.map((n) => n.codeModule)).toEqual(["packages/editor"]);
    expect(drift!.items).toContain("new: @crystal/editor");
    expect(drift!.items).toContain("new dependency: @crystal/editor → @crystal/core");
    // The projection is what a sync would save.
    expect(drift!.projected.nodes.some((n) => n.codeModule === "packages/editor")).toBe(true);
  });

  it("detects a deleted module (its edges drop with it)", () => {
    const shrunk: CodeMapSummary = {
      ...summary,
      modules: summary.modules.filter((m) => m.path !== "apps/web"),
      deps: summary.deps.filter((d) => d.source !== "apps/web"),
    };
    const drift = detectDrift(seeded(), shrunk);
    expect(drift).not.toBeNull();
    expect(drift!.diff.removedNodes.map((n) => n.codeModule)).toEqual(["apps/web"]);
    expect(drift!.diff.removedEdges).toHaveLength(1);
    expect(drift!.total).toBe(2);
    expect(drift!.items).toContain("removed: @crystal/web");
  });

  it("does not flag import-weight-only changes as drift", () => {
    const reweighted: CodeMapSummary = {
      ...summary,
      deps: summary.deps.map((d) => ({ ...d, weight: d.weight + 10 })),
    };
    expect(detectDrift(seeded(), reweighted)).toBeNull();
  });

  it("caps the item list", () => {
    const many: CodeMapSummary = {
      ...summary,
      modules: [
        ...summary.modules,
        ...Array.from({ length: 9 }, (_, i) => ({
          path: `packages/extra-${i}`,
          name: `extra-${i}`,
          fileCount: 2,
        })),
      ],
    };
    const drift = detectDrift(seeded(), many)!;
    expect(drift.total).toBe(9);
    expect(drift.items).toHaveLength(7); // 6 lines + the "+N more" tail
    expect(drift.items.at(-1)).toBe("+3 more");
  });
});

describe("driftSignature", () => {
  it("is stable for the same drift and changes when the drift moves on", () => {
    const grown: CodeMapSummary = {
      ...summary,
      modules: [...summary.modules, { path: "packages/editor", name: "@crystal/editor", fileCount: 6 }],
    };
    const graph = seeded();
    const a = detectDrift(graph, grown)!;
    const b = detectDrift(graph, grown)!;
    expect(driftSignature("arch.json", a)).toBe(driftSignature("arch.json", b));
    const grownMore: CodeMapSummary = {
      ...grown,
      modules: [...grown.modules, { path: "packages/sdk", name: "@crystal/sdk", fileCount: 4 }],
    };
    const c = detectDrift(graph, grownMore)!;
    expect(driftSignature("arch.json", c)).not.toBe(driftSignature("arch.json", a));
    expect(driftSignature("other.json", a)).not.toBe(driftSignature("arch.json", a));
  });
});
