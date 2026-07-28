import { describe, expect, it } from "vitest";
import {
  composeArchitecture,
  createArchOverlay,
  isPositionalOverride,
  reconcileOverlay,
  setNodeOverride,
  type ArchOverlay,
} from "./arch-overlay.js";
import type { ArchEdge, ArchNode, ArchitectureGraph } from "./architecture.js";

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

const edge = (id: string, source: string, target: string): ArchEdge => ({
  id,
  source,
  target,
  kind: "sync",
  label: "",
});

const derived = (nodes: ArchNode[], edges: ArchEdge[] = []): ArchitectureGraph => ({
  id: "arch",
  name: "Derived",
  description: "",
  nodes,
  edges,
  environments: [],
  journeys: [],
  facets: [],
});

const overlay = (patch: Partial<ArchOverlay> = {}): ArchOverlay => ({
  ...createArchOverlay(),
  ...patch,
});

describe("composeArchitecture", () => {
  it("applies overrides, appends manual nodes/edges and takes overlay graph-level state", () => {
    const d = derived(
      [node("sys:auth"), node("sys:api")],
      [edge("e1", "sys:auth", "sys:api")],
    );
    const o = overlay({
      overrides: { "sys:auth": { x: 10, y: 20, label: "Auth service", accent: "cyan" } },
      manualNodes: [node("queue:jobs", { kind: "queue", label: "Jobs queue" })],
      manualEdges: [edge("m1", "sys:api", "queue:jobs")],
    });
    const composed = composeArchitecture(d, o);
    const auth = composed.nodes.find((n) => n.id === "sys:auth")!;
    expect(auth.position).toEqual({ x: 10, y: 20 });
    expect(auth.label).toBe("Auth service");
    expect(auth.accent).toBe("cyan");
    expect(composed.nodes.map((n) => n.id)).toContain("queue:jobs");
    expect(composed.edges.map((e) => e.id)).toEqual(["e1", "m1"]);
    expect(composed.environments).toBe(o.environments);
  });

  it("hides subtrees: a hidden container removes its descendants and their edges", () => {
    const d = derived(
      [node("sys:a", { kind: "system" }), node("part", { parentId: "sys:a" }), node("sys:b")],
      [edge("e1", "part", "sys:b")],
    );
    const composed = composeArchitecture(d, overlay({ hiddenIds: ["sys:a"] }));
    expect(composed.nodes.map((n) => n.id)).toEqual(["sys:b"]);
    expect(composed.edges).toEqual([]);
  });

  it("drops manual edges with dangling endpoints from the composition only", () => {
    const d = derived([node("sys:a")]);
    const o = overlay({ manualEdges: [edge("m1", "sys:a", "sys:gone")] });
    expect(composeArchitecture(d, o).edges).toEqual([]);
    expect(o.manualEdges).toHaveLength(1); // overlay untouched
  });

  it("merges placement overrides over derived placements per environment", () => {
    const d = derived([
      node("sys:a", { placements: { env1: { target: "aws", runtime: "ecs" } } }),
    ]);
    const o = overlay({
      overrides: { "sys:a": { placements: { env2: { target: "vercel", runtime: "" } } } },
    });
    const composed = composeArchitecture(d, o);
    expect(composed.nodes[0]!.placements).toEqual({
      env1: { target: "aws", runtime: "ecs" },
      env2: { target: "vercel", runtime: "" },
    });
  });

  it("explicit null parentId override pins a derived child to root", () => {
    const d = derived([node("sys:a", { kind: "system" }), node("part", { parentId: "sys:a" })]);
    const o = overlay({ overrides: { part: { parentId: null } } });
    const composed = composeArchitecture(d, o);
    expect(composed.nodes.find((n) => n.id === "part")!.parentId).toBeNull();
  });
});

describe("setNodeOverride", () => {
  it("merges patches and prunes emptied entries", () => {
    let o = overlay();
    o = setNodeOverride(o, "sys:a", { x: 1, y: 2 });
    o = setNodeOverride(o, "sys:a", { label: "A" });
    expect(o.overrides["sys:a"]).toEqual({ x: 1, y: 2, label: "A" });
    o = setNodeOverride(o, "sys:a", null);
    expect(o.overrides["sys:a"]).toBeUndefined();
  });

  it("undefined fields in a patch delete those keys, pruning when empty", () => {
    let o = overlay({ overrides: { "sys:a": { label: "A" } } });
    o = setNodeOverride(o, "sys:a", { label: undefined });
    expect(o.overrides["sys:a"]).toBeUndefined();
  });
});

describe("reconcileOverlay", () => {
  it("drops positional-only overrides and hidden ids for vanished nodes", () => {
    const o = overlay({
      overrides: {
        "sys:gone": { x: 1, y: 2 },
        "sys:kept": { x: 3, y: 4 },
      },
      hiddenIds: ["sys:gone", "sys:kept"],
    });
    const { overlay: next, staleIds } = reconcileOverlay(o, derived([node("sys:kept")]));
    expect(next.overrides).toEqual({ "sys:kept": { x: 3, y: 4 } });
    expect(next.hiddenIds).toEqual(["sys:kept"]);
    expect(staleIds).toEqual([]);
  });

  it("keeps semantic overrides on vanished ids and reports them stale", () => {
    const o = overlay({
      overrides: { "sys:gone": { x: 1, y: 2, label: "Renamed", sim: { replicas: 3 } } },
    });
    const { overlay: next, staleIds } = reconcileOverlay(o, derived([]));
    expect(next.overrides["sys:gone"]).toBeDefined();
    expect(staleIds).toEqual(["sys:gone"]);
  });

  it("manual nodes count as known — their overrides never go stale", () => {
    const o = overlay({
      manualNodes: [node("queue:jobs", { kind: "queue" })],
      overrides: { "queue:jobs": { x: 5, y: 6, label: "Jobs" } },
    });
    const { overlay: next, staleIds } = reconcileOverlay(o, derived([]));
    expect(next.overrides["queue:jobs"]).toBeDefined();
    expect(staleIds).toEqual([]);
  });
});

describe("isPositionalOverride", () => {
  it("treats x/y/parentId/size as positional and anything else as semantic", () => {
    expect(isPositionalOverride({ x: 1, y: 2, parentId: null, size: null })).toBe(true);
    expect(isPositionalOverride({ x: 1, y: 2, label: "A" })).toBe(false);
    expect(isPositionalOverride({})).toBe(true);
  });
});
