import { describe, expect, it } from "vitest";
import { createArchNode, createArchitectureGraph } from "./architecture.js";
import {
  canNestZone,
  deleteDeployTarget,
  duplicateEnvironment,
  moveDeployTarget,
  normalizeDeployTargets,
  normalizeOverlayDeployTargets,
  placementTargetId,
  removeEnvironment,
  renameDeployTarget,
  upsertDeployTarget,
  zoneNestingRejection,
} from "./arch-deploy.js";

describe("deployment target normalization", () => {
  it("mints stable targets, migrates pins, repairs mirrors, and is idempotent", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{
      id: "prod", name: "Production", kind: "cloud", targets: [],
      layout: { " ECS ": { x: 10, y: 20, zone: "subnet:a" } },
    }];
    const a = createArchNode("service", "A", { x: 0, y: 0 });
    const b = createArchNode("service", "B", { x: 0, y: 0 });
    a.placements.prod = { target: "ECS", runtime: "fargate" };
    b.placements.prod = { target: "  ecs  ", runtime: "worker" };
    graph.nodes = [a, b];

    const normalized = normalizeDeployTargets(graph);
    expect(normalized).not.toBe(graph);
    expect(graph.environments[0]!.layout).toBeDefined();
    expect(normalized.environments[0]).toMatchObject({
      targets: [{ id: "tgt:prod:ecs", name: "ECS", x: 10, y: 20, zone: "subnet:a" }],
    });
    expect(normalized.environments[0]!.layout).toBeUndefined();
    expect(normalized.nodes.map((node) => node.placements.prod)).toEqual([
      { target: "ECS", targetId: "tgt:prod:ecs", runtime: "fargate" },
      { target: "ECS", targetId: "tgt:prod:ecs", runtime: "worker" },
    ]);
    expect(normalizeDeployTargets(normalized)).toBe(normalized);
  });

  it("does not mutate its input", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud" }];
    graph.nodes = [createArchNode("service", "A", { x: 0, y: 0 })];
    graph.nodes[0]!.placements.e = { target: "ECS", runtime: "" };
    const before = JSON.stringify(graph);
    normalizeDeployTargets(graph);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("suffixes genuine slug collisions and repairs dangling target ids", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", targets: [] }];
    const nodes = ["a", "b", "c"].map((id) => createArchNode("service", id, { x: 0, y: 0 }));
    nodes[0]!.placements.e = { target: "a+b", runtime: "" };
    nodes[1]!.placements.e = { target: "a b", runtime: "" };
    nodes[2]!.placements.e = { target: "Orphan", targetId: "custom:id", runtime: "" };
    graph.nodes = nodes;
    const normalized = normalizeDeployTargets(graph);
    expect(normalized.environments[0]!.targets!.map((target) => target.id)).toEqual([
      "tgt:e:a-b", "tgt:e:a-b-2", "custom:id",
    ]);
    expect(normalized.nodes[2]!.placements.e!.target).toBe("Orphan");
  });

  it("leaves unreferenced environment target records untouched", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", targets: [] }];
    expect(normalizeDeployTargets(graph)).toBe(graph);
  });

  it("preserves graph, environment, and node identity when already canonical", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", targets: [{ id: "t", name: "T", kind: "other" }] }];
    graph.nodes = [createArchNode("service", "A", { x: 0, y: 0 })];
    graph.nodes[0]!.placements.e = { target: "T", targetId: "t", runtime: "" };
    const normalized = normalizeDeployTargets(graph);
    expect(normalized).toBe(graph);
    expect(normalized.environments[0]).toBe(graph.environments[0]);
    expect(normalized.nodes[0]).toBe(graph.nodes[0]);
  });

  it("names a dangling id without a target mirror Unknown target", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", targets: [] }];
    graph.nodes = [createArchNode("service", "A", { x: 0, y: 0 })];
    graph.nodes[0]!.placements.e = { target: undefined as unknown as string, targetId: "missing", runtime: "" };
    const normalized = normalizeDeployTargets(graph);
    expect(normalized.environments[0]!.targets).toContainEqual({ id: "missing", name: "Unknown target", kind: "other" });
    expect(normalized.nodes[0]!.placements.e!.target).toBe("Unknown target");
  });

  it("mints an empty pinned target from an unmatched layout key", () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", layout: { Lambda: { x: 3, y: 4 } } }];
    const normalized = normalizeDeployTargets(graph);
    expect(normalized.environments[0]!.targets).toEqual([
      { id: "tgt:e:lambda", name: "Lambda", kind: "other", x: 3, y: 4 },
    ]);
  });

  it("normalizes raw overlays and seeds legacy zone visibility", () => {
    const raw = {
      environments: [{ id: "e", name: "E", kind: "cloud" }],
      overrides: { a: { placements: { e: { target: "ECS", runtime: "" } } } },
      manualNodes: [{ id: "v", kind: "vpc", placements: {}, label: "V" }],
    };
    const normalized = normalizeOverlayDeployTargets(raw) as typeof raw & {
      environments: Array<Record<string, unknown>>;
    };
    expect(normalized.environments[0]!.infraNodeIds).toEqual(["v"]);
    expect(normalized.environments[0]!.targets).toEqual([
      { id: "tgt:e:ecs", name: "ECS", kind: "other" },
    ]);
    expect((normalized.overrides.a.placements.e as Record<string, unknown>).targetId).toBe("tgt:e:ecs");
    expect(raw.environments[0]).not.toHaveProperty("targets");
    expect(normalizeOverlayDeployTargets(null)).toBeNull();
  });

  it("normalizes manual-node placements and preserves explicit empty membership", () => {
    const raw = {
      environments: [{ id: "e", name: "E", kind: "cloud", infraNodeIds: [] }],
      overrides: {},
      manualNodes: [
        { id: "v", kind: "vpc", placements: {}, label: "V" },
        { id: "n", kind: "service", placements: { e: { target: "VM", runtime: "" } }, label: "N" },
      ],
    };
    const normalized = normalizeOverlayDeployTargets(raw) as any;
    expect(normalized.environments[0].infraNodeIds).toEqual([]);
    expect(normalized.manualNodes[1].placements.e.targetId).toBe("tgt:e:vm");
  });

  it.each([
    ["target records", { environments: [{ id: "e", targets: ["junk"] }], overrides: {}, manualNodes: [] }],
    ["override placements", { environments: [{ id: "e" }], overrides: { n: { placements: { e: { target: 7 } } } }, manualNodes: [] }],
    ["manual placements", { environments: [{ id: "e" }], overrides: {}, manualNodes: [{ placements: { e: {} } }] }],
    ["layout pins", { environments: [{ id: "e", layout: { T: "junk" } }], overrides: {}, manualNodes: [] }],
  ])("returns the original raw value for junk %s", (_label, raw) => {
    expect(normalizeOverlayDeployTargets(raw)).toBe(raw);
  });
});

describe("deployment helpers", () => {
  const fixture = () => {
    const graph = createArchitectureGraph("g");
    graph.environments = [{ id: "e", name: "E", kind: "cloud", targets: [] }];
    graph.nodes = [createArchNode("service", "A", { x: 0, y: 0 })];
    return graph;
  };

  it("upserts, renames, moves, and deletes targets with placement mirrors", () => {
    let graph = upsertDeployTarget(fixture(), "e", { id: "t1", name: "Old", kind: "compute" });
    graph.nodes[0]!.placements.e = { target: "Old", targetId: "t1", runtime: "" };
    graph = renameDeployTarget(graph, "e", "t1", "New");
    expect(graph.nodes[0]!.placements.e.target).toBe("New");
    graph = moveDeployTarget(graph, "e", "t1", { x: 4, y: 5, zone: "z" });
    expect(graph.environments[0]!.targets![0]).toMatchObject({ x: 4, y: 5, zone: "z" });
    graph = moveDeployTarget(graph, "e", "t1", null);
    expect(graph.environments[0]!.targets![0]).not.toHaveProperty("x");
    expect(graph.environments[0]!.targets![0]).not.toHaveProperty("zone");
    graph = deleteDeployTarget(graph, "e", "t1");
    expect(graph.environments[0]!.targets).toEqual([]);
    expect(graph.nodes[0]!.placements.e).toBeUndefined();
    expect(placementTargetId({ targetId: "x" })).toBe("x");
    expect(placementTargetId(null)).toBeUndefined();
  });

  it("duplicates target ids and placements while sharing infra node references", () => {
    const graph = fixture();
    graph.environments[0] = { ...graph.environments[0]!, infraNodeIds: ["v"], targets: [{ id: "t", name: "T", kind: "other" }] };
    graph.nodes[0]!.placements.e = { target: "T", targetId: "t", runtime: "" };
    const duplicated = duplicateEnvironment(graph, "e", "Copy");
    const copy = duplicated.environments[1]!;
    expect(copy.name).toBe("Copy");
    expect(copy.targets![0]!.id).not.toBe("t");
    expect(copy.infraNodeIds).toEqual(["v"]);
    expect(duplicated.nodes[0]!.placements[copy.id]!.targetId).toBe(copy.targets![0]!.id);
  });

  it("removes environment placements and zones no longer referenced", () => {
    const graph = fixture();
    graph.environments[0] = { ...graph.environments[0]!, infraNodeIds: ["v"] };
    graph.nodes.push(createArchNode("vpc", "V", { x: 0, y: 0 }));
    graph.nodes[1]!.id = "v";
    graph.nodes[0]!.placements.e = { target: "T", runtime: "" };
    const removed = removeEnvironment(graph, "e");
    expect(removed.environments).toEqual([]);
    expect(removed.nodes.map((node) => node.id)).not.toContain("v");
    expect(removed.nodes[0]!.placements.e).toBeUndefined();
  });

  it("prunes only unreferenced environment-scoped notes", () => {
    const graph = fixture();
    graph.environments = [
      { id: "e", name: "E", kind: "cloud", infraNodeIds: ["gone"], targets: [] },
      { id: "keep", name: "Keep", kind: "cloud", infraNodeIds: ["shared"], targets: [] },
    ];
    graph.nodes = [
      { ...createArchNode("note", "Gone", { x: 0, y: 0 }), id: "gone" },
      { ...createArchNode("note", "Shared", { x: 0, y: 0 }), id: "shared" },
    ];
    const removed = removeEnvironment(graph, "e");
    expect(removed.nodes.map((node) => node.id)).toEqual(["shared"]);
  });

  it("preserves an architecture-canvas note that the removed environment never referenced", () => {
    const graph = fixture();
    graph.environments = [
      { id: "e", name: "E", kind: "cloud", infraNodeIds: ["owned"], targets: [] },
      { id: "keep", name: "Keep", kind: "cloud", infraNodeIds: [], targets: [] },
    ];
    graph.nodes = [
      { ...createArchNode("note", "Owned", { x: 0, y: 0 }), id: "owned" },
      { ...createArchNode("note", "Canvas", { x: 0, y: 0 }), id: "canvas" },
    ];
    const removed = removeEnvironment(graph, "e");
    expect(removed.nodes.map((node) => node.id)).toEqual(["canvas"]);
  });

  it("retains shared zones, drops removed-zone edges, and reparents children", () => {
    const graph = fixture();
    graph.environments = [
      { id: "e", name: "E", kind: "cloud", infraNodeIds: ["gone"], targets: [] },
      { id: "keep", name: "Keep", kind: "cloud", infraNodeIds: ["shared"], targets: [] },
    ];
    const gone = { ...createArchNode("vpc", "Gone", { x: 0, y: 0 }), id: "gone" };
    const shared = { ...createArchNode("vpc", "Shared", { x: 0, y: 0 }), id: "shared" };
    const child = { ...createArchNode("service", "Child", { x: 0, y: 0 }, "gone"), id: "child" };
    graph.nodes = [gone, shared, child];
    graph.edges = [{ id: "edge", source: "gone", target: "child", kind: "dependency", label: "" }];
    const removed = removeEnvironment(graph, "e");
    expect(removed.nodes.map((node) => node.id)).toEqual(["shared", "child"]);
    expect(removed.nodes.find((node) => node.id === "child")!.parentId).toBeNull();
    expect(removed.edges).toEqual([]);
  });

  it("does not prune zones when surviving membership is legacy-unknown", () => {
    const graph = fixture();
    graph.environments = [
      { id: "e", name: "E", kind: "cloud", infraNodeIds: ["v"], targets: [] },
      { id: "legacy", name: "Legacy", kind: "cloud", targets: [] },
    ];
    graph.nodes = [{ ...createArchNode("vpc", "V", { x: 0, y: 0 }), id: "v" }];
    expect(removeEnvironment(graph, "e").nodes[0]!.id).toBe("v");
  });
});

describe("zone nesting", () => {
  it("implements the refined containment matrix", () => {
    expect(canNestZone("zone", "region")).toBe(true);
    expect(canNestZone("vpc", "region")).toBe(true);
    expect(canNestZone("cluster", "zone")).toBe(true);
    expect(canNestZone("securitygroup", "subnet")).toBe(true);
    expect(canNestZone("namespace", "cluster")).toBe(true);
    expect(canNestZone("region", "vpc")).toBe(false);
    expect(zoneNestingRejection("securitygroup", "region")).toContain("security group");
    expect(zoneNestingRejection("namespace", "cluster")).toBeNull();
  });
});
