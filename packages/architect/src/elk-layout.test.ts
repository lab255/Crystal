import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";
import { estimateCardSize } from "./card-metrics.js";
import {
  elkAutoLayout,
  filterRoutesForMovedEndpoints,
  placeFallbackEdgeLabels,
  type ElkRoute,
  type ElkRouteLabel,
} from "./elk-layout.js";

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Box = Point & Size;

function node(id: string, kind: ArchNodeKind, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), ...patch, id };
}

function graph(
  nodes: ArchNode[],
  edges: ArchitectureGraph["edges"] = [],
): ArchitectureGraph {
  return { ...createArchitectureGraph("C4 containers"), id: "arch:c4", nodes, edges };
}

function fixture(): { graph: ArchitectureGraph; dims: Map<string, Size> } {
  const user = node("person:user", "person");
  const boundary = node("c4:appliance.sh", "system");
  const http = node("ext:http", "external");
  // The ext: id deliberately exercises the external-ish convention even
  // though this projection renders the object as a datastore.
  const s3 = node("ext:s3:bucket", "datastore");
  const cards = [
    node("ctr:web", "container", { parentId: boundary.id }),
    node("ctr:console", "container", { parentId: boundary.id }),
    node("ctr:api", "container", { parentId: boundary.id }),
    node("ctr:auth", "container", { parentId: boundary.id }),
    node("ctr:worker", "container", { parentId: boundary.id }),
    node("ctr:events", "container", { parentId: boundary.id }),
    node("ctr:database", "container", { parentId: boundary.id }),
  ];
  const dims = new Map<string, Size>([
    [user.id, { width: 120, height: 80 }],
    [http.id, { width: 224, height: 110 }],
    [s3.id, { width: 224, height: 130 }],
    ...cards.map(
      (card, index) =>
        [card.id, { width: 288, height: [120, 140, 160, 180, 200, 220, 260][index]! }] as const,
    ),
  ]);
  return {
    graph: graph(
      [user, boundary, ...cards, http, s3],
      [
        { id: "e:user-web", source: user.id, target: "ctr:web", kind: "sync", label: "uses" },
        { id: "e:user-console", source: user.id, target: "ctr:console", kind: "sync", label: "administers" },
        { id: "e:web-api", source: "ctr:web", target: "ctr:api", kind: "sync", label: "calls" },
        { id: "e:console-api", source: "ctr:console", target: "ctr:api", kind: "sync", label: "calls" },
        { id: "e:api-auth", source: "ctr:api", target: "ctr:auth", kind: "dependency", label: "authenticates" },
        { id: "e:api-worker", source: "ctr:api", target: "ctr:worker", kind: "async", label: "queues" },
        { id: "e:worker-events", source: "ctr:worker", target: "ctr:events", kind: "dependency", label: "publishes" },
        { id: "e:auth-db", source: "ctr:auth", target: "ctr:database", kind: "data", label: "reads" },
        { id: "e:events-db", source: "ctr:events", target: "ctr:database", kind: "data", label: "writes" },
        { id: "e:api-s3", source: "ctr:api", target: s3.id, kind: "data", label: "objects" },
        { id: "e:console-http", source: "ctr:console", target: http.id, kind: "sync", label: "webhook" },
      ],
    ),
    dims,
  };
}

function absolutePositions(graph: ArchitectureGraph): Map<string, Point> {
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const result = new Map<string, Point>();
  const resolving = new Set<string>();
  const resolve = (id: string): Point => {
    const cached = result.get(id);
    if (cached) return cached;
    if (resolving.has(id)) throw new Error(`cycle at ${id}`);
    const item = byId.get(id);
    if (!item) throw new Error(`missing ${id}`);
    resolving.add(id);
    const parent = item.parentId ? resolve(item.parentId) : { x: 0, y: 0 };
    const absolute = { x: parent.x + item.position.x, y: parent.y + item.position.y };
    resolving.delete(id);
    result.set(id, absolute);
    return absolute;
  };
  for (const item of graph.nodes) resolve(item.id);
  return result;
}

function boxesOf(graph: ArchitectureGraph, dims: ReadonlyMap<string, Size>): Map<string, Box> {
  const absolute = absolutePositions(graph);
  return new Map(
    graph.nodes.map((item) => {
      const point = absolute.get(item.id)!;
      const size = item.size ?? dims.get(item.id) ?? estimateCardSize(item);
      return [item.id, { ...point, ...size }];
    }),
  );
}

function expandedBy(box: Box, amount: number): Box {
  return {
    x: box.x - amount,
    y: box.y - amount,
    width: box.width + 2 * amount,
    height: box.height + 2 * amount,
  };
}

function contains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function labelsOverlap(a: ElkRouteLabel, b: ElkRouteLabel): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

describe("elkAutoLayout", () => {
  it("fits compounds, separates every sibling scope, and follows C4 ranks", async () => {
    const input = fixture();
    const { graph: laid } = await elkAutoLayout(input.graph, { dims: input.dims });
    const boxes = boxesOf(laid, input.dims);

    for (const item of laid.nodes) {
      expect(Number.isFinite(item.position.x), `${item.id} x`).toBe(true);
      expect(Number.isFinite(item.position.y), `${item.id} y`).toBe(true);
      if (!item.parentId) continue;
      const parent = laid.nodes.find((candidate) => candidate.id === item.parentId)!;
      const size = item.size ?? input.dims.get(item.id) ?? estimateCardSize(item);
      expect(item.position.x, `${item.id} left padding`).toBeGreaterThanOrEqual(24);
      expect(item.position.y, `${item.id} header padding`).toBeGreaterThanOrEqual(56);
      expect(item.position.x + size.width, `${item.id} right padding`).toBeLessThanOrEqual(
        parent.size!.width - 24 + 0.01,
      );
      expect(item.position.y + size.height, `${item.id} bottom padding`).toBeLessThanOrEqual(
        parent.size!.height - 24 + 0.01,
      );
    }

    const byScope = new Map<string | null, ArchNode[]>();
    for (const item of laid.nodes) {
      const scope = item.parentId ?? null;
      const siblings = byScope.get(scope) ?? [];
      siblings.push(item);
      byScope.set(scope, siblings);
    }
    for (const siblings of byScope.values()) {
      for (let i = 0; i < siblings.length; i += 1) {
        const a = boxes.get(siblings[i]!.id)!;
        for (let j = i + 1; j < siblings.length; j += 1) {
          const b = boxes.get(siblings[j]!.id)!;
          const overlaps =
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y;
          expect(overlaps, `${siblings[i]!.id} overlaps ${siblings[j]!.id}`).toBe(false);
        }
      }
    }

    const user = boxes.get("person:user")!;
    const boundary = boxes.get("c4:appliance.sh")!;
    expect(user.y + user.height).toBeLessThanOrEqual(boundary.y);
    expect(boundary.y + boundary.height).toBeLessThanOrEqual(boxes.get("ext:http")!.y);
    expect(boundary.y + boundary.height).toBeLessThanOrEqual(boxes.get("ext:s3:bucket")!.y);
  });

  it("is deterministic and returns finite, endpoint-adjacent same-scope routes", async () => {
    const input = fixture();
    const first = await elkAutoLayout(input.graph, { dims: input.dims });
    const second = await elkAutoLayout(input.graph, { dims: input.dims });
    expect(second).toEqual(first);

    const boxes = boxesOf(first.graph, input.dims);
    const nodes = new Map(first.graph.nodes.map((item) => [item.id, item]));
    const sameScope = input.graph.edges.filter(
      (edge) => nodes.get(edge.source)?.parentId === nodes.get(edge.target)?.parentId,
    );
    expect(sameScope.length).toBeGreaterThan(0);
    for (const edge of sameScope) {
      const route = first.routes.get(edge.id);
      expect(route, `${edge.id} has sections`).toBeDefined();
    }

    const edges = new Map(input.graph.edges.map((edge) => [edge.id, edge]));
    for (const [edgeId, route] of first.routes) {
      const edge = edges.get(edgeId)!;
      expect(route.points.length, `${edge.id} point count`).toBeGreaterThanOrEqual(2);
      for (const point of route.points) {
        expect(Number.isFinite(point.x), `${edge.id} route x`).toBe(true);
        expect(Number.isFinite(point.y), `${edge.id} route y`).toBe(true);
      }
      expect(contains(expandedBy(boxes.get(edge.source)!, 150), route.points[0]!)).toBe(true);
      expect(contains(expandedBy(boxes.get(edge.target)!, 150), route.points.at(-1)!)).toBe(true);
      if (edge.label.trim()) expect(route.label, `${edge.id} label position`).toBeDefined();
    }

    const graphBounds = [...boxes.values()].reduce(
      (bounds, box) => ({
        x: Math.min(bounds.x, box.x),
        y: Math.min(bounds.y, box.y),
        right: Math.max(bounds.right, box.x + box.width),
        bottom: Math.max(bounds.bottom, box.y + box.height),
      }),
      { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
    );
    for (const [edgeId, route] of first.routes) {
      if (!route.label) continue;
      expect(Number.isFinite(route.label.x), `${edgeId} label x`).toBe(true);
      expect(Number.isFinite(route.label.y), `${edgeId} label y`).toBe(true);
      expect(route.label.x, `${edgeId} label left`).toBeGreaterThanOrEqual(graphBounds.x);
      expect(route.label.y, `${edgeId} label top`).toBeGreaterThanOrEqual(graphBounds.y);
      expect(route.label.x + route.label.width, `${edgeId} label right`).toBeLessThanOrEqual(
        graphBounds.right,
      );
      expect(route.label.y + route.label.height, `${edgeId} label bottom`).toBeLessThanOrEqual(
        graphBounds.bottom,
      );
    }
  });

  it("packs sparse scopes toward the diagram aspect instead of one endless row", async () => {
    // A components-level projection of a big shared-library container: dozens
    // of members, almost no intra-scope edges. Hierarchical layered layout
    // strings these into a single row (component packing is unsupported with
    // INCLUDE_CHILDREN); the sparse-scope rule must rectangle-pack instead.
    const pen = node("ctr:shared", "group", { size: { width: 640, height: 420 } });
    const outside = node("svc:consumer", "service");
    const members = Array.from({ length: 24 }, (_, i) =>
      node(`cmp:m${i}`, "service", { parentId: pen.id }),
    );
    const input = graph(
      [pen, outside, ...members],
      [
        { id: "e:0-1", source: "cmp:m0", target: "cmp:m1", kind: "dependency", label: "" },
        { id: "e:2-3", source: "cmp:m2", target: "cmp:m3", kind: "dependency", label: "" },
        // Crosses the packed boundary — ELK crashes on a hierarchical edge
        // into a rectpacked scope unless the endpoint snaps to the border.
        {
          id: "e:in",
          source: outside.id,
          target: "cmp:m5",
          kind: "sync",
          label: "crosses packed scope",
        },
      ],
    );
    const dims = new Map(members.map((m) => [m.id, { width: 224, height: 96 }]));

    const { graph: laid, routes } = await elkAutoLayout(input, { dims });
    expect(routes.has("e:in")).toBe(false);
    const fitted = laid.nodes.find((n) => n.id === pen.id)!.size!;
    const aspect = fitted.width / fitted.height;
    expect(aspect).toBeLessThan(4);
    expect(aspect).toBeGreaterThan(0.5);

    const boxes = boxesOf(laid, dims);
    for (let i = 0; i < members.length; i += 1) {
      const a = boxes.get(members[i]!.id)!;
      for (let j = i + 1; j < members.length; j += 1) {
        const b = boxes.get(members[j]!.id)!;
        const overlaps =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlaps, `${members[i]!.id} overlaps ${members[j]!.id}`).toBe(false);
      }
    }
  });

  it("uses the requested aspect ratio when rectangle-packing a sparse scope", async () => {
    const pen = node("ctr:shared", "group", { size: { width: 640, height: 420 } });
    const members = Array.from({ length: 20 }, (_, i) =>
      node(`cmp:m${i}`, "service", { parentId: pen.id }),
    );
    const input = graph([pen, ...members]);
    const dims = new Map(members.map((member) => [member.id, { width: 180, height: 90 }]));

    const wide = await elkAutoLayout(input, { dims, aspectRatio: 3 });
    const tall = await elkAutoLayout(input, { dims, aspectRatio: 0.75 });
    const wideSize = wide.graph.nodes.find((item) => item.id === pen.id)!.size!;
    const tallSize = tall.graph.nodes.find((item) => item.id === pen.id)!.size!;

    expect(wideSize.width / wideSize.height).toBeGreaterThan(tallSize.width / tallSize.height);
  });
});

describe("placeFallbackEdgeLabels", () => {
  it("separates overlapping labels deterministically in edge-id order", () => {
    const points = [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ];
    const routes = new Map<string, ElkRoute>([
      ["edge:z", { points }],
      ["edge:a", { points }],
    ]);
    const labels = new Map([
      ["edge:z", "same label"],
      ["edge:a", "same label"],
    ]);

    const first = placeFallbackEdgeLabels(routes, labels);
    const second = placeFallbackEdgeLabels(routes, labels);
    expect(second).toEqual(first);
    const a = first.get("edge:a")!.label!;
    const z = first.get("edge:z")!.label!;
    expect(labelsOverlap(a, z)).toBe(false);
    // The lexically first edge owns the unchanged midpoint.
    expect(a.x + a.width / 2).toBe(100);
    expect(a.y + a.height / 2).toBe(50);
  });
});

describe("filterRoutesForMovedEndpoints", () => {
  it("drops routes when an endpoint moves absolutely through its parent chain", () => {
    const parent = node("ctr:parent", "container", { size: { width: 400, height: 300 } });
    const child = node("svc:child", "service", { parentId: parent.id, position: { x: 20, y: 30 } });
    const peer = node("svc:peer", "service", { position: { x: 500, y: 40 } });
    const stableA = node("svc:a", "service", { position: { x: 0, y: 500 } });
    const stableB = node("svc:b", "service", { position: { x: 200, y: 500 } });
    const laid = graph(
      [parent, child, peer, stableA, stableB],
      [
        { id: "nested", source: child.id, target: peer.id, kind: "sync", label: "" },
        { id: "stable", source: stableA.id, target: stableB.id, kind: "sync", label: "" },
      ],
    );
    const displayed = {
      ...laid,
      nodes: laid.nodes.map((item) =>
        item.id === parent.id ? { ...item, position: { x: 10, y: 0 } } : item,
      ),
    };
    const routes = new Map<string, ElkRoute>([
      ["nested", { points: [{ x: 20, y: 30 }, { x: 500, y: 40 }] }],
      ["stable", { points: [{ x: 0, y: 500 }, { x: 200, y: 500 }] }],
    ]);

    const filtered = filterRoutesForMovedEndpoints(laid, displayed, routes);
    expect(filtered.has("nested")).toBe(false);
    expect(filtered.get("stable")).toEqual(routes.get("stable"));
  });

  it("keeps the original map when sub-pixel differences stay within tolerance", () => {
    const laid = graph([node("a", "service"), node("b", "service")], [
      { id: "ab", source: "a", target: "b", kind: "sync", label: "" },
    ]);
    const displayed = {
      ...laid,
      nodes: laid.nodes.map((item) => ({
        ...item,
        position: { x: item.position.x + 0.5, y: item.position.y - 0.5 },
      })),
    };
    const routes = new Map<string, ElkRoute>([
      ["ab", { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
    ]);
    expect(filterRoutesForMovedEndpoints(laid, displayed, routes)).toBe(routes);
  });
});
