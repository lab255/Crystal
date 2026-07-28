import { describe, expect, it } from "vitest";
import { migrateLegacyToOverlay } from "./arch-migrate.js";
import { composeArchitecture } from "./arch-overlay.js";
import { deriveArchGraph } from "./arch-derive.js";
import type { ArchNode, ArchitectureGraph } from "./architecture.js";
import { overview, system } from "./arch-derive.test.js";

const AUTH = system({
  id: "sys:auth",
  name: "Authentication",
  parts: [{ path: "packages/server/src/auth", pkg: "packages/server", fileCount: 8 }],
});
const UI = system({
  id: "sys:ui",
  name: "UI",
  role: "shared",
  layer: "frontend",
  parts: [{ path: "packages/ui", pkg: "packages/ui", fileCount: 20 }],
});

const node = (id: string, patch: Partial<ArchNode> = {}): ArchNode => ({
  id,
  kind: "service",
  label: id,
  description: "",
  parentId: null,
  position: { x: 0, y: 0 },
  size: null,
  tech: [],
  placements: {},
  ...patch,
});

const diagram = (
  name: string,
  nodes: ArchNode[],
  edges: ArchitectureGraph["edges"] = [],
): ArchitectureGraph => ({
  id: `arch_${name}`,
  name,
  description: "",
  nodes,
  edges,
  environments: [],
  journeys: [],
  facets: [],
});

describe("migrateLegacyToOverlay", () => {
  it("re-parents grouped systems into manual group nodes, positions left to layout", () => {
    const out = migrateLegacyToOverlay({
      diagrams: [],
      layout: {
        positions: {
          "sys:auth": { x: 40, y: 60 }, // foreign canvas space — not migrated
          "grp:backend": { x: 10, y: 10 },
          "sys:gone": { x: 1, y: 2 }, // no longer derives — inert
        },
        groups: [{ id: "grp:backend", name: "Backend", members: ["sys:auth", "sys:gone"] }],
      },
      overview: overview([AUTH, UI]),
    });
    expect(out.overrides["sys:auth"]).toEqual({ parentId: "grp:backend" });
    expect(out.overrides["sys:gone"]).toBeUndefined();
    const group = out.manualNodes.find((n) => n.id === "grp:backend")!;
    expect(group.kind).toBe("group");
    expect(group.position).toEqual({ x: 0, y: 0 }); // auto-layout owns it
  });

  it("migrates a diagram losslessly: matched nodes → overrides, rest → manual, diagram → facet", () => {
    const legacy = diagram(
      "Payment flow",
      [
        node("n1", {
          label: "Authentication",
          codeModule: "packages/server/src/auth",
          accent: "cyan",
          position: { x: 100, y: 120 },
        }),
        node("n2", { label: "Jobs queue", kind: "queue", position: { x: 300, y: 120 } }),
      ],
      [{ id: "e1", source: "n1", target: "n2", kind: "async", label: "enqueue" }],
    );
    const out = migrateLegacyToOverlay({
      diagrams: [{ path: ".crystal/architecture/payment.crystal", graph: legacy }],
      layout: null,
      overview: overview([AUTH, UI]),
    });
    // matched by codeModule → semantic override on the canonical id (no
    // position — coordinate spaces don't transfer)
    expect(out.overrides["sys:auth"]).toEqual({ accent: "cyan" });
    // the queue nothing derives → manual node, edge re-pointed at the canonical id
    expect(out.manualNodes.map((n) => n.id)).toEqual(["n2"]);
    expect(out.manualEdges).toEqual([
      { id: "e1", source: "sys:auth", target: "n2", kind: "async", label: "enqueue" },
    ]);
    // the diagram survives as a facet with sourcePath for old ?diagram= links
    const facet = out.facets.find((f) => f.sourcePath === ".crystal/architecture/payment.crystal")!;
    expect(facet.name).toBe("Payment flow");
    expect(facet.nodeIds).toEqual(["sys:auth", "n2"]);
  });

  it("later diagrams contribute facets but never clobber the first diagram's overrides", () => {
    const first = diagram("Main", [
      node("a", { label: "Authentication", accent: "cyan", position: { x: 1, y: 1 } }),
    ]);
    const second = diagram("Alt", [
      node("b", { label: "Authentication", position: { x: 999, y: 999 }, accent: "rose" }),
    ]);
    const out = migrateLegacyToOverlay({
      diagrams: [
        { path: "a.crystal", graph: first },
        { path: "b.crystal", graph: second },
      ],
      layout: null,
      overview: overview([AUTH]),
    });
    expect(out.overrides["sys:auth"]).toEqual({ accent: "cyan" });
    expect(out.facets).toHaveLength(2);
  });

  it("skips the empty auto-seeded diagram and composes cleanly", () => {
    const out = migrateLegacyToOverlay({
      diagrams: [{ path: "overview.crystal", graph: diagram("Overview", []) }],
      layout: null,
      overview: overview([AUTH, UI]),
    });
    expect(out.facets).toEqual([]);
    expect(out.environments).toHaveLength(1); // seeded local env
    const derived = deriveArchGraph({
      overview: overview([AUTH, UI]),
      externals: [],
      modules: [],
    });
    const composed = composeArchitecture(derived, out);
    expect(composed.nodes.map((n) => n.id)).toEqual(["sys:auth", "sys:ui"]);
  });
});
