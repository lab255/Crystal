import { describe, expect, it } from "vitest";
import { createArchitectureGraph, createArchNode } from "@crystal/core";
import {
  absolutePosition,
  addEdge,
  containerAtPoint,
  deleteNodes,
  reparentNode,
} from "./graph-ops.js";

function fixture() {
  const graph = createArchitectureGraph("t");
  const sys = createArchNode("system", "sys", { x: 100, y: 100 });
  sys.size = { width: 400, height: 300 };
  const inner = createArchNode("group", "inner", { x: 50, y: 60 }, sys.id);
  inner.size = { width: 200, height: 150 };
  const svc = createArchNode("service", "svc", { x: 20, y: 30 }, inner.id);
  const lone = createArchNode("service", "lone", { x: 900, y: 40 });
  graph.nodes.push(sys, inner, svc, lone);
  return { graph, sys, inner, svc, lone };
}

describe("graph-ops", () => {
  it("resolves absolute positions through nesting", () => {
    const { graph, svc } = fixture();
    expect(absolutePosition(graph, svc.id)).toEqual({ x: 170, y: 190 });
  });

  it("reparents keeping absolute position", () => {
    const { graph, sys, lone } = fixture();
    const next = reparentNode(graph, lone.id, sys.id, { x: 150, y: 150 });
    const moved = next.nodes.find((n) => n.id === lone.id)!;
    expect(moved.parentId).toBe(sys.id);
    expect(moved.position).toEqual({ x: 50, y: 50 });
    expect(absolutePosition(next, lone.id)).toEqual({ x: 150, y: 150 });
  });

  it("refuses cyclic reparenting", () => {
    const { graph, sys, inner } = fixture();
    const next = reparentNode(graph, sys.id, inner.id, { x: 0, y: 0 });
    expect(next).toBe(graph);
  });

  it("cascade-deletes descendants and touching edges", () => {
    const { graph, sys, svc, lone } = fixture();
    const withEdge = addEdge(graph, svc.id, lone.id, "async");
    const next = deleteNodes(withEdge, [sys.id]);
    expect(next.nodes.map((n) => n.id)).toEqual([lone.id]);
    expect(next.edges).toHaveLength(0);
  });

  it("finds the deepest container at a point", () => {
    const { graph, sys, inner, svc } = fixture();
    // Point inside both sys (100..500, 100..400) and inner (150..350, 160..310).
    expect(containerAtPoint(graph, { x: 200, y: 200 })?.id).toBe(inner.id);
    // Point only inside sys.
    expect(containerAtPoint(graph, { x: 460, y: 380 })?.id).toBe(sys.id);
    // Excluding the subtree that contains `inner`.
    expect(containerAtPoint(graph, { x: 200, y: 200 }, sys.id)).toBeNull();
    // Outside everything.
    expect(containerAtPoint(graph, { x: 5, y: 5 })).toBeNull();
    // svc is not a container.
    expect(containerAtPoint(graph, { x: 175, y: 195 }, svc.id)?.id).toBe(inner.id);
  });

  it("dedupes edges and rejects self-loops", () => {
    const { graph, svc, lone } = fixture();
    let g = addEdge(graph, svc.id, lone.id, "sync");
    g = addEdge(g, svc.id, lone.id, "async");
    g = addEdge(g, svc.id, svc.id, "sync");
    expect(g.edges).toHaveLength(1);
  });
});
