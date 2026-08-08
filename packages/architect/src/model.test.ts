import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";
import { toRfEdges, toRfNodes } from "./model.js";

function node(id: string, kind: ArchNodeKind, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), ...patch, id };
}

function graph(nodes: ArchNode[]): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), id: "arch_1", environments: [], nodes };
}

const NONE: ReadonlySet<string> = new Set();

describe("toRfNodes — reserved LOD slots", () => {
  it("renders slotted leaves at their reserved footprint", () => {
    const g = graph([node("svc", "service")]);
    const slots = new Map([["svc", { width: 640, height: 480 }]]);
    const [rf] = toRfNodes(g, NONE, slots);
    expect(rf!.width).toBe(640);
    expect(rf!.height).toBe(480);
    expect(rf!.data.slot).toEqual({ width: 640, height: 480 });
  });

  it("leaves without a slot keep content sizing", () => {
    const g = graph([node("svc", "service")]);
    const [rf] = toRfNodes(g, NONE, new Map());
    expect(rf!.width).toBeUndefined();
    expect(rf!.data.slot).toBeUndefined();
  });

  it("containers keep their own size — slots never apply", () => {
    const g = graph([node("sys", "system", { size: { width: 500, height: 300 } })]);
    const slots = new Map([["sys", { width: 999, height: 999 }]]);
    const [rf] = toRfNodes(g, NONE, slots);
    expect(rf!.width).toBe(500);
    expect(rf!.height).toBe(300);
    expect(rf!.data.slot).toBeUndefined();
  });
});

describe("toRfEdges — ELK routes", () => {
  it("uses the elk edge and route data only when that edge has a route", () => {
    const g = {
      ...graph([node("a", "service"), node("b", "service"), node("c", "service")]),
      edges: [
        { id: "ab", source: "a", target: "b", kind: "sync" as const, label: "" },
        { id: "bc", source: "b", target: "c", kind: "async" as const, label: "" },
      ],
    };
    const route = {
      points: [
        { x: 10, y: 20 },
        { x: 10, y: 80 },
        { x: 90, y: 80 },
      ],
      label: { x: 15, y: 25, width: 40, height: 17 },
    };

    const edges = toRfEdges(g, NONE, null, new Map([["ab", route]]));
    expect(edges[0]).toMatchObject({ type: "elk", data: { route } });
    expect(edges[0]!.data!.route).not.toBe(route);
    expect(edges[0]!.data!.route!.points).not.toBe(route.points);
    expect(edges[0]!.data!.route!.label).not.toBe(route.label);
    expect(edges[1]!.type).toBe("default");
    expect(edges[1]!.data).not.toHaveProperty("route");
  });
});
