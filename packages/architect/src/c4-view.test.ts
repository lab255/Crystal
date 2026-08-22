import { describe, expect, it } from "vitest";
import {
  createArchOverlay,
  type ArchNode,
  type ArchitectureGraph,
  type C4Projection,
} from "@crystal/core";
import {
  applyAggregateOverrides,
  applyC4Edit,
  c4AddRejection,
  c4Reserve,
  filterC4DeletionIds,
  projectFacets,
  remapFlowProjection,
} from "./c4-view.js";
import type { FlowProjection } from "./dataflow.js";

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

function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return {
    id: "g",
    name: "g",
    description: "",
    nodes,
    edges,
    environments: [],
    journeys: [],
    facets: [],
  };
}

const DERIVED = graph(
  [node("sys:api"), node("sys:model")],
  [{ id: "link:sys:api->sys:model", source: "sys:api", target: "sys:model", kind: "dependency", label: "" }],
);

/** What the C4 containers level showed: boundary + two container cards. */
const PROJECTED = graph(
  [
    node("c4:system", { kind: "system", size: { width: 640, height: 420 } }),
    node("ctr:apps-server", { kind: "container", parentId: "c4:system", position: { x: 10, y: 40 } }),
    node("sys:api", { parentId: "ctr:apps-server", position: { x: 20, y: 60 } }),
  ],
  [],
);

describe("filterC4DeletionIds", () => {
  it("blocks every derived node aggregate while preserving ordinary node deletes", () => {
    expect(
      filterC4DeletionIds(
        ["sys:api", "ctr:apps-server", "c4:system", "c4:boundary:payments", "person:user"],
        "node",
      ),
    ).toEqual({
      deletable: ["sys:api"],
      blocked: ["ctr:apps-server", "c4:system", "c4:boundary:payments", "person:user"],
    });
  });

  it("blocks aggregate edges while preserving ordinary edge deletes", () => {
    expect(filterC4DeletionIds(["link:a->b", "c4rel:a->b"], "edge")).toEqual({
      deletable: ["link:a->b"],
      blocked: ["c4rel:a->b"],
    });
  });

  it("refuses manual additions only at Components scope", () => {
    expect(c4AddRejection({ level: "components", scope: "ctr:api" })).toContain(
      "switch to Containers",
    );
    expect(c4AddRejection({ level: "containers" })).toBeNull();
  });
});

describe("applyC4Edit", () => {
  it("preserves overlay identity when the canvas edit changes nothing", () => {
    const overlay = createArchOverlay();
    expect(applyC4Edit({
      overlay,
      derived: DERIVED,
      projected: PROJECTED,
      edited: PROJECTED,
      viewKey: "containers",
    })).toBe(overlay);
  });

  it("records drags as per-level pins", () => {
    const edited = {
      ...PROJECTED,
      nodes: PROJECTED.nodes.map((n) =>
        n.id === "ctr:apps-server" ? { ...n, position: { x: 100, y: 90 } } : n,
      ),
    };
    const out = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected: PROJECTED,
      edited,
      viewKey: "containers",
    });
    expect(out.c4Layouts).toEqual({ containers: { "ctr:apps-server": { x: 100, y: 90 } } });
    expect(out.overrides).toEqual({});
  });

  it("renames aggregates via overrides and derived nodes too", () => {
    const edited = {
      ...PROJECTED,
      nodes: PROJECTED.nodes.map((n) =>
        n.id === "ctr:apps-server" ? { ...n, label: "Bridge server" } : n,
      ),
    };
    const out = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected: PROJECTED,
      edited,
      viewKey: "containers",
    });
    expect(out.overrides["ctr:apps-server"]).toEqual({ label: "Bridge server" });
  });

  it("hides deleted derived nodes, ignores deleted aggregates", () => {
    const edited = {
      ...PROJECTED,
      nodes: PROJECTED.nodes.filter((n) => n.id !== "sys:api" && n.id !== "ctr:apps-server"),
    };
    const out = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected: PROJECTED,
      edited,
      viewKey: "containers",
    });
    expect(out.hiddenIds).toEqual(["sys:api"]);
    expect(out.manualNodes).toEqual([]);
  });

  it("pins schema entities per level and treats deletion as a projection-only no-op", () => {
    const entity = node("schema:src/data.ts#User", {
      kind: "entity",
      parentId: "ctr:apps-server",
      entityFields: ["id", "email"],
    });
    const projected = { ...PROJECTED, nodes: [...PROJECTED.nodes, entity] };
    const moved = {
      ...projected,
      nodes: projected.nodes.map((n) =>
        n.id === entity.id ? { ...n, position: { x: 75, y: 125 } } : n,
      ),
    };
    const pinned = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected,
      edited: moved,
      viewKey: "components:ctr:apps-server",
    });
    expect(pinned.c4Layouts["components:ctr:apps-server"]?.[entity.id]).toEqual({
      x: 75,
      y: 125,
    });

    const deleted = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected,
      edited: { ...projected, nodes: projected.nodes.filter((n) => n.id !== entity.id) },
      viewKey: "components:ctr:apps-server",
    });
    expect(deleted.hiddenIds).toEqual([]);
    expect(deleted.manualNodes).toEqual([]);
  });

  it("adds manual nodes pinned where dropped, parent only when canonical", () => {
    const person = node("node:p1", { kind: "person", parentId: "c4:system", position: { x: 5, y: 6 } });
    const edited = { ...PROJECTED, nodes: [...PROJECTED.nodes, person] };
    const out = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected: PROJECTED,
      edited,
      viewKey: "containers",
    });
    expect(out.manualNodes).toHaveLength(1);
    // The aggregate parent is display-only — the durable record is unparented.
    expect(out.manualNodes[0]).toMatchObject({ id: "node:p1", parentId: null });
    expect(out.c4Layouts.containers?.["node:p1"]).toEqual({ x: 5, y: 6 });
  });

  it("keeps drawn edges (aggregate endpoints allowed) and removes deleted manual ones", () => {
    const overlay = {
      ...createArchOverlay(),
      manualEdges: [
        { id: "e-old", source: "sys:api", target: "c4:system", kind: "sync" as const, label: "" },
      ],
    };
    const projectedWithEdge = {
      ...PROJECTED,
      edges: [{ id: "e-old", source: "sys:api", target: "c4:system", kind: "sync" as const, label: "" }],
    };
    const edited = {
      ...projectedWithEdge,
      edges: [
        { id: "e-new", source: "node:p1", target: "ctr:apps-server", kind: "sync" as const, label: "Uses" },
      ],
    };
    const out = applyC4Edit({
      overlay,
      derived: DERIVED,
      projected: projectedWithEdge,
      edited,
      viewKey: "containers",
    });
    expect(out.manualEdges.map((e) => e.id)).toEqual(["e-new"]);
  });
});

describe("applyC4Edit · facets", () => {
  const FACET = { id: "f1", name: "Auth", description: "", nodeIds: ["sys:api", "sys:model"] };

  it("applies membership deltas against the translated view, releasing rolled members", () => {
    const overlay = { ...createArchOverlay(), facets: [FACET] };
    // At containers level the facet showed as its roll-up: the container card.
    const projected = { ...PROJECTED, facets: [{ ...FACET, nodeIds: ["ctr:apps-server"] }] };
    // The user removed the container from the facet and added the boundary.
    const edited = { ...projected, facets: [{ ...FACET, nodeIds: ["c4:system"] }] };
    const out = applyC4Edit({
      overlay,
      derived: DERIVED,
      projected,
      edited,
      viewKey: "containers",
      nodeRollup: { "sys:api": "ctr:apps-server", "sys:model": "ctr:shared" },
    });
    // sys:api rolled into the removed container → released; sys:model kept.
    expect(out.facets[0]?.nodeIds).toEqual(["sys:model", "c4:system"]);
  });

  it("adopts facets created on the C4 canvas", () => {
    const edited = {
      ...PROJECTED,
      facets: [{ id: "f2", name: "New", description: "", nodeIds: ["ctr:apps-server"] }],
    };
    const out = applyC4Edit({
      overlay: createArchOverlay(),
      derived: DERIVED,
      projected: PROJECTED,
      edited,
      viewKey: "containers",
    });
    expect(out.facets.map((f) => f.id)).toEqual(["f2"]);
  });
});

describe("projectFacets", () => {
  it("maps members through the roll-up and leaves unrepresented facets alone", () => {
    const projection: C4Projection = {
      graph: graph([node("ctr:apps-server", { kind: "container" })]),
      typeLines: {},
      nodeRollup: { "sys:api": "ctr:apps-server" },
      edgeRollup: {},
      drill: {},
      view: { level: "containers" },
    };
    const [mapped, untouched] = projectFacets(
      [
        { id: "f1", name: "A", description: "", nodeIds: ["sys:api", "sys:gone"] },
        { id: "f2", name: "B", description: "", nodeIds: ["sys:gone"] },
      ],
      projection,
    );
    expect(mapped?.nodeIds).toEqual(["ctr:apps-server"]);
    expect(untouched?.nodeIds).toEqual(["sys:gone"]);
  });
});

describe("applyAggregateOverrides", () => {
  it("decorates aggregates but never double-applies to canonical ids", () => {
    const overrides = {
      "ctr:apps-server": { label: "Bridge" },
      "sys:api": { label: "SHOULD NOT APPLY" },
    };
    const out = applyAggregateOverrides(PROJECTED, overrides, new Set(["sys:api", "sys:model"]));
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("ctr:apps-server")?.label).toBe("Bridge");
    expect(byId.get("sys:api")?.label).toBe("sys:api");
  });
});

describe("c4Reserve", () => {
  it("reserves the compact entity card footprint", () => {
    const entity = node("schema:src/data.ts#User", { kind: "entity" });
    expect(c4Reserve(graph([entity])).get(entity.id)).toEqual({ width: 180, height: 90 });
  });

  it("estimates bare container kinds while preserving authoritative base entries", () => {
    const container = node("ctr:web", { kind: "container" });
    const bareSystem = node("sys:bare", { kind: "system", size: null });
    const measured = { width: 360, height: 210 };
    const reserve = c4Reserve(graph([container, bareSystem]), new Map([[container.id, measured]]));

    expect(reserve.get(container.id)).toEqual(measured);
    expect(reserve.get(bareSystem.id)).toEqual({ width: 288, height: 56 });
  });
});

describe("remapFlowProjection", () => {
  it("follows roll-ups and folds internal hops away", () => {
    const projection: C4Projection = {
      graph: graph(
        [node("ctr:apps-server", { kind: "container" }), node("ctr:shared", { kind: "container" })],
        [{ id: "c4rel:ctr:apps-server->ctr:shared", source: "ctr:apps-server", target: "ctr:shared", kind: "dependency", label: "" }],
      ),
      typeLines: {},
      nodeRollup: { "sys:api": "ctr:apps-server", "sys:auth": "ctr:apps-server", "sys:model": "ctr:shared" },
      edgeRollup: { "link:sys:api->sys:model": "c4rel:ctr:apps-server->ctr:shared" },
      drill: {},
      view: { level: "containers" },
    };
    const flow: FlowProjection = {
      nodeOrder: [
        { nodeId: "sys:api", firstStep: 0 },
        { nodeId: "sys:auth", firstStep: 1 },
        { nodeId: "sys:model", firstStep: 2 },
      ],
      edgeSteps: new Map([["link:sys:api->sys:model", [2]]]),
      ghostHops: [
        { source: "sys:api", target: "sys:auth", step: 1 }, // internal — folds away
        { source: "sys:auth", target: "sys:model", step: 2 },
      ],
      unmappedSteps: [],
      stepNodeIds: new Map([["a.ts#f", "sys:api"]]),
    };
    const out = remapFlowProjection(flow, projection);
    expect(out.nodeOrder).toEqual([
      { nodeId: "ctr:apps-server", firstStep: 0 },
      { nodeId: "ctr:shared", firstStep: 2 },
    ]);
    expect([...out.edgeSteps.keys()]).toEqual(["c4rel:ctr:apps-server->ctr:shared"]);
    expect(out.ghostHops).toEqual([{ source: "ctr:apps-server", target: "ctr:shared", step: 2 }]);
    expect(out.stepNodeIds.get("a.ts#f")).toBe("ctr:apps-server");
  });
});
