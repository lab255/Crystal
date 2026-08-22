import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";
import {
  autoLayout,
  autoLayoutFitted,
  fitContainersToChildren,
  scopeIsFullstack,
  scopeLayerOf,
} from "./layout.js";
import { splitInfraOnly } from "./arch-view-filter.js";

function node(id: string, kind: ArchNodeKind, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), ...patch, id };
}

function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), id: "arch_1", environments: [], nodes, edges };
}

function fixedSeedShuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0;
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

const topOf = (g: ArchitectureGraph, id: string) => g.nodes.find((n) => n.id === id)!.position.y;
const geometryOf = (g: ArchitectureGraph) =>
  Object.fromEntries(
    g.nodes
      .map((n) => [n.id, { position: n.position, size: n.size }] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

describe("autoLayout — flow mode", () => {
  it("is invariant to node and edge permutations without mutating persisted order", () => {
    const nodes = ["b2", "a1", "solo-b", "b1", "a2", "solo-a"].map((id) =>
      node(id, "service"),
    );
    const edges: ArchitectureGraph["edges"] = [
      { id: "b", source: "b1", target: "b2", kind: "sync", label: "" },
      { id: "a", source: "a1", target: "a2", kind: "sync", label: "" },
    ];
    const originalNodeOrder = nodes.map((n) => n.id);
    const originalEdgeOrder = edges.map((e) => e.id);
    const expected = geometryOf(autoLayout(graph(nodes, edges)));

    for (const [nodeOrder, edgeOrder] of [
      [[...nodes].reverse(), [...edges].reverse()],
      [[nodes[2]!, nodes[5]!, nodes[3]!, nodes[0]!, nodes[4]!, nodes[1]!], edges],
    ] as const) {
      expect(geometryOf(autoLayout(graph([...nodeOrder], [...edgeOrder])))).toEqual(expected);
    }
    expect(nodes.map((n) => n.id)).toEqual(originalNodeOrder);
    expect(edges.map((e) => e.id)).toEqual(originalEdgeOrder);
  });

  it("lays out a zone-stripped projection exactly like a graph that never had zones", () => {
    const clean = graph([node("a", "service"), node("b", "datastore")], [{ id: "ab", source: "a", target: "b", kind: "sync", label: "" }]);
    const withZone = { ...clean, nodes: [...clean.nodes, node("region", "region")], edges: [...clean.edges, { id: "zone-edge", source: "region", target: "a", kind: "sync" as const, label: "" }] };
    expect(autoLayout(splitInfraOnly(withZone).view)).toEqual(autoLayout(clean));
  });
  it("assigns finite positions to every node", () => {
    const g = graph(
      [node("a", "service"), node("b", "datastore")],
      [{ id: "e", source: "a", target: "b", kind: "sync", label: "" }],
    );
    const laid = autoLayout(g);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("packs disconnected siblings into compact wrapped rows", () => {
    const g = graph(Array.from({ length: 13 }, (_, i) => node(`n${i}`, "service")));
    const laid = autoLayout(g);
    const xs = new Set(laid.nodes.map((n) => n.position.x));
    const ys = new Set(laid.nodes.map((n) => n.position.y));
    const right = Math.max(...laid.nodes.map((n) => n.position.x + 200));

    expect(xs.size).toBeGreaterThan(1);
    expect(ys.size).toBe(3);
    expect(right).toBeLessThanOrEqual(1200);
  });

  it("keeps mixed connected-component footprints pairwise non-overlapping", () => {
    const ids = ["a1", "a2", "b1", "b2", "b3", "solo1", "solo2"];
    const sizes = new Map([
      ["a1", { width: 260, height: 90 }],
      ["a2", { width: 180, height: 160 }],
      ["b1", { width: 380, height: 100 }],
      ["b2", { width: 140, height: 220 }],
      ["b3", { width: 240, height: 80 }],
      ["solo1", { width: 510, height: 130 }],
      ["solo2", { width: 170, height: 300 }],
    ]);
    const laid = autoLayout(
      graph(
        ids.map((id) => node(id, "service")),
        [
          { id: "ea", source: "a1", target: "a2", kind: "sync", label: "" },
          { id: "eb1", source: "b1", target: "b2", kind: "sync", label: "" },
          { id: "eb2", source: "b2", target: "b3", kind: "sync", label: "" },
        ],
      ),
      { reserve: sizes },
    );

    for (let i = 0; i < laid.nodes.length; i += 1) {
      const a = laid.nodes[i]!;
      const aSize = sizes.get(a.id)!;
      for (let j = i + 1; j < laid.nodes.length; j += 1) {
        const b = laid.nodes[j]!;
        const bSize = sizes.get(b.id)!;
        const overlaps =
          a.position.x < b.position.x + bSize.width &&
          a.position.x + aSize.width > b.position.x &&
          a.position.y < b.position.y + bSize.height &&
          a.position.y + aSize.height > b.position.y;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});

describe("autoLayout — reserved footprints", () => {
  it("spaces ranks by the reserved (future expanded) size, not the collapsed leaf", () => {
    const g = graph(
      [node("a", "service"), node("b", "datastore")],
      [{ id: "e", source: "a", target: "b", kind: "sync", label: "" }],
    );
    const reserve = new Map([["a", { width: 840, height: 620 }]]);
    const laid = autoLayout(g, { reserve });
    // b must clear a's whole reserved slot, so expanding a never covers it.
    expect(topOf(laid, "b")).toBeGreaterThanOrEqual(topOf(laid, "a") + 620);
  });

  it("spaces disconnected siblings by reserved footprints when rows wrap", () => {
    const g = graph([node("a", "service"), node("b", "service")]);
    const reserve = new Map([
      ["a", { width: 840, height: 620 }],
      ["b", { width: 840, height: 620 }],
    ]);
    const laid = autoLayout(g, { reserve });
    expect(topOf(laid, "b")).toBeGreaterThanOrEqual(topOf(laid, "a") + 620);
  });

  it("fitContainersToChildren sizes containers around reserved child footprints", () => {
    const g = graph([
      node("sys", "system"),
      node("a", "service", { parentId: "sys", position: { x: 24, y: 48 } }),
    ]);
    const reserve = new Map([["a", { width: 840, height: 620 }]]);
    const fitted = fitContainersToChildren(g, undefined, reserve);
    const size = fitted.nodes.find((n) => n.id === "sys")!.size!;
    // The container must hold the child at its reserved (future expanded)
    // size, so LOD growth stays inside the box the layout drew.
    expect(size.width).toBeGreaterThanOrEqual(24 + 840);
    expect(size.height).toBeGreaterThanOrEqual(48 + 620);
  });
});

describe("autoLayoutFitted — C4 boundaries", () => {
  it("fits the C4 system boundary around its containers instead of the minted placeholder", () => {
    // The projection mints the boundary at 640×420; five reserved-size
    // containers overflow that badly unless the fit pass owns it.
    const containers = Array.from({ length: 5 }, (_, i) =>
      node(`ctr:c${i}`, "container", { parentId: "c4:system", size: null }),
    );
    const g = graph([
      node("c4:system", "system", { size: { width: 640, height: 420 } }),
      ...containers,
      node("ext:stripe", "external"),
    ]);
    const reserve = new Map(containers.map((c) => [c.id, { width: 300, height: 170 }]));
    const laid = autoLayoutFitted(g, { mode: "flow", reserve });
    const boundary = laid.nodes.find((n) => n.id === "c4:system")!;
    for (const c of containers) {
      const child = laid.nodes.find((n) => n.id === c.id)!;
      expect(child.position.x + 300).toBeLessThanOrEqual(boundary.size!.width + 1);
      expect(child.position.y + 170).toBeLessThanOrEqual(boundary.size!.height + 1);
    }
    // The external neighbor clears the fitted boundary, not the placeholder.
    const ext = laid.nodes.find((n) => n.id === "ext:stripe")!;
    const overlapsX =
      ext.position.x < boundary.position.x + boundary.size!.width &&
      ext.position.x + 200 > boundary.position.x;
    const overlapsY =
      ext.position.y < boundary.position.y + boundary.size!.height &&
      ext.position.y + 84 > boundary.position.y;
    expect(overlapsX && overlapsY).toBe(false);
  });
});

describe("autoLayout — layers mode", () => {
  it("keeps band geometry invariant under input permutations", () => {
    const nodes = [
      node("data-b", "datastore"),
      node("entry-b", "gateway"),
      node("service-b", "service"),
      node("entry-a", "external"),
      node("data-a", "queue"),
      node("service-a", "service"),
    ];
    const edges: ArchitectureGraph["edges"] = [
      { id: "z", source: "entry-b", target: "entry-a", kind: "sync", label: "" },
      { id: "a", source: "service-a", target: "service-b", kind: "sync", label: "" },
    ];
    const expected = geometryOf(autoLayout(graph(nodes, edges), { mode: "layers" }));
    expect(
      geometryOf(
        autoLayout(graph([...nodes].reverse(), [...edges].reverse()), { mode: "layers" }),
      ),
    ).toEqual(expected);
    expect(
      geometryOf(
        autoLayout(graph(fixedSeedShuffle(nodes, 0x51a7), fixedSeedShuffle(edges, 0xc0de)), {
          mode: "layers",
        }),
      ),
    ).toEqual(expected);
  });

  it("stacks entry above service above data (backend-only scope)", () => {
    const g = graph([
      node("db", "datastore"),
      node("api", "service"),
      node("gw", "gateway"),
      node("ext", "external"),
      node("q", "queue"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "gw")).toBeLessThan(topOf(laid, "api"));
    expect(topOf(laid, "ext")).toBeLessThan(topOf(laid, "api"));
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "db"));
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "q"));
    // Nodes in the same band share a top edge.
    expect(topOf(laid, "gw")).toBe(topOf(laid, "ext"));
  });

  it("respects explicit layer overrides", () => {
    const g = graph([
      node("mw", "service", { layer: "entry" }), // middleware pinned to the entry tier
      node("api", "service"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "mw")).toBeLessThan(topOf(laid, "api"));
  });

  it("keeps container children parent-relative and banded within the scope", () => {
    const g = graph([
      node("sys", "system"),
      node("gw", "gateway", { parentId: "sys" }),
      node("db", "datastore", { parentId: "sys" }),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    // Children positions are parent-relative: inside the container's padding.
    expect(topOf(laid, "gw")).toBeGreaterThanOrEqual(48);
    expect(topOf(laid, "gw")).toBeLessThan(topOf(laid, "db"));
  });
});

const leftOf = (g: ArchitectureGraph, id: string) => g.nodes.find((n) => n.id === id)!.position.x;

describe("autoLayout — fullstack scopes", () => {
  it("lays mixed frontend + backend scopes out left-to-right across the stack", () => {
    const g = graph([
      node("db", "datastore"),
      node("api", "service"),
      node("gw", "gateway"),
      node("web", "frontend"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(leftOf(laid, "web")).toBeLessThan(leftOf(laid, "gw"));
    expect(leftOf(laid, "gw")).toBeLessThan(leftOf(laid, "api"));
    expect(leftOf(laid, "api")).toBeLessThan(leftOf(laid, "db"));
  });

  it("keeps backend-only scopes vertical", () => {
    const g = graph([node("db", "datastore"), node("api", "service")]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "db"));
    expect(scopeIsFullstack(g, ["db", "api"])).toBe(false);
  });

  it("treats containers by their majority descendants", () => {
    const g = graph([
      node("apps", "group"),
      node("web", "frontend", { parentId: "apps" }),
      node("svc", "service"),
    ]);
    expect(scopeIsFullstack(g, ["apps", "svc"])).toBe(true);
    const laid = autoLayout(g, { mode: "layers" });
    expect(leftOf(laid, "apps")).toBeLessThan(leftOf(laid, "svc"));
  });
});

describe("scopeLayerOf", () => {
  it("bands containers by the majority layer of their descendants", () => {
    const g = graph([
      node("grp", "group"),
      node("db1", "datastore", { parentId: "grp" }),
      node("db2", "datastore", { parentId: "grp" }),
      node("svc", "service", { parentId: "grp" }),
    ]);
    expect(scopeLayerOf(g, g.nodes[0]!)).toBe("data");
  });

  it("prefers an explicit override on the container itself", () => {
    const g = graph([
      node("grp", "group", { layer: "entry" }),
      node("db", "datastore", { parentId: "grp" }),
    ]);
    expect(scopeLayerOf(g, g.nodes[0]!)).toBe("entry");
  });
});
