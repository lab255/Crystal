import { describe, expect, it } from "vitest";
import {
  ArchOverlaySchema,
  createArchOverlay,
  reconcileOverlay,
  setC4Position,
} from "./arch-overlay.js";
import type { ArchNode, ArchitectureGraph } from "./architecture.js";
import { formatDeepLink, parseDeepLink } from "./deeplink.js";

function node(id: string, over: Partial<ArchNode> = {}): ArchNode {
  return {
    id,
    kind: "service",
    label: id,
    description: "",
    parentId: null,
    position: { x: 0, y: 0 },
    size: null,
    tech: [],
    placements: {},
    layer: null,
    ...over,
  };
}

function graph(nodes: ArchNode[]): ArchitectureGraph {
  return {
    id: "arch:derived",
    name: "Architecture",
    description: "",
    nodes,
    edges: [],
    environments: [],
    journeys: [],
    facets: [],
  };
}

describe("overlay c4Layouts", () => {
  it("round-trips through the schema and defaults empty on old files", () => {
    const overlay = ArchOverlaySchema.parse({});
    expect(overlay.c4Layouts).toEqual({});
    const pinned = setC4Position(overlay, "containers", "ctr:web", { x: 10, y: 20 });
    expect(ArchOverlaySchema.parse(pinned).c4Layouts).toEqual({
      containers: { "ctr:web": { x: 10, y: 20 } },
    });
  });

  it("unpins and prunes empty view entries", () => {
    let overlay = setC4Position(createArchOverlay(), "context", "person:user", { x: 1, y: 2 });
    overlay = setC4Position(overlay, "context", "person:user", null);
    expect(overlay.c4Layouts).toEqual({});
  });

  it("reconcile keeps pins on derived and extra-known ids, drops the rest", () => {
    let overlay = createArchOverlay();
    overlay = setC4Position(overlay, "containers", "sys:auth", { x: 5, y: 5 });
    overlay = setC4Position(overlay, "containers", "ctr:web", { x: 9, y: 9 });
    overlay = setC4Position(
      overlay,
      "components:ctr:web",
      "schema:src/data.ts#User",
      { x: 12, y: 24 },
    );
    overlay = setC4Position(overlay, "components:ctr:web", "sys:gone", { x: 1, y: 1 });
    overlay = { ...overlay, overrides: { "ctr:web": { label: "Storefront" } } };

    const derived = graph([node("sys:auth")]);
    const { overlay: out, staleIds } = reconcileOverlay(overlay, derived, [
      "ctr:web",
      "schema:src/data.ts#User",
    ]);
    expect(out.c4Layouts).toEqual({
      containers: { "sys:auth": { x: 5, y: 5 }, "ctr:web": { x: 9, y: 9 } },
      "components:ctr:web": { "schema:src/data.ts#User": { x: 12, y: 24 } },
    });
    // The renamed container is known, not stale.
    expect(out.overrides["ctr:web"]).toEqual({ label: "Storefront" });
    expect(staleIds).toEqual([]);
  });
});

describe("deep links · C4 level/scope", () => {
  it("omits the default level and round-trips the rest", () => {
    expect(formatDeepLink({ mode: "architect", architect: { level: "containers" } })).toBe(
      "#/architect/architecture",
    );
    const url = formatDeepLink({
      mode: "architect",
      architect: { level: "components", scope: "ctr:apps-server" },
    });
    expect(url).toBe("#/architect/architecture?level=components&scope=ctr%3Aapps-server");
    expect(parseDeepLink(url)?.architect).toMatchObject({
      view: "architecture",
      level: "components",
      scope: "ctr:apps-server",
    });
    // Unknown levels are ignored, not propagated.
    expect(
      parseDeepLink("#/architect/architecture?level=blueprints")?.architect?.level,
    ).toBeUndefined();
  });

  it("keeps the legacy view aliases resolving", () => {
    expect(parseDeepLink("#/architect/systems?system=sys%3Aauth")?.architect).toMatchObject({
      view: "architecture",
      system: "sys:auth",
    });
    expect(parseDeepLink("#/architect/diagrams")?.architect?.view).toBe("architecture");
    expect(parseDeepLink("#/architect/codemap")?.architect?.view).toBe("codebase");
  });
});
