import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";
import { diffEdgeStatus, diffGraphs, diffNodeStatus, diffTotal } from "./arch-diff.js";
import { normalizeDeployTargets } from "./arch-deploy.js";

function node(id: string, kind: ArchNode["kind"] = "service"): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), id };
}

function edge(id: string, source: string, target: string, label = ""): ArchEdge {
  return { id, source, target, kind: "dependency", label };
}

function graph(nodes: ArchNode[], edges: ArchEdge[] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), nodes, edges };
}

describe("diffGraphs", () => {
  it("reports added, removed and changed nodes", () => {
    const base = graph([node("a"), node("b")]);
    const target = graph([{ ...node("a"), label: "renamed" }, node("c")]);
    const diff = diffGraphs(base, target);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(["c"]);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(["b"]);
    expect(diff.changedNodes).toHaveLength(1);
    expect(diff.changedNodes[0]!.fields).toEqual(["label"]);
    expect(diffTotal(diff)).toBe(3);
  });

  it("ignores pure geometry moves but counts reparenting", () => {
    const base = graph([node("grp", "group"), node("a")]);
    const moved = graph([
      node("grp", "group"),
      { ...node("a"), position: { x: 500, y: 500 } },
    ]);
    expect(diffTotal(diffGraphs(base, moved))).toBe(0);

    const reparented = graph([node("grp", "group"), { ...node("a"), parentId: "grp" }]);
    const diff = diffGraphs(base, reparented);
    expect(diff.changedNodes[0]!.fields).toEqual(["parentId"]);
  });

  it("matches edges by connection, not id", () => {
    const base = graph([node("a"), node("b")], [edge("e1", "a", "b", "×2")]);
    const regenerated = graph([node("a"), node("b")], [edge("e9", "a", "b", "×2")]);
    expect(diffTotal(diffGraphs(base, regenerated))).toBe(0);

    const reweighted = graph([node("a"), node("b")], [edge("e9", "a", "b", "×5")]);
    const diff = diffGraphs(base, reweighted);
    expect(diff.changedEdges).toHaveLength(1);
    expect(diff.changedEdges[0]!.fields).toEqual(["label"]);
  });

  it("reports added and removed edges", () => {
    const base = graph([node("a"), node("b"), node("c")], [edge("e1", "a", "b")]);
    const target = graph([node("a"), node("b"), node("c")], [edge("e2", "b", "c")]);
    const diff = diffGraphs(base, target);
    expect(diff.addedEdges.map((e) => e.id)).toEqual(["e2"]);
    expect(diff.removedEdges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("placements count as semantic changes (infra review)", () => {
    const base = graph([node("a")]);
    const placed = graph([
      { ...node("a"), placements: { prod: { target: "ecs", runtime: "" } } },
    ]);
    expect(diffGraphs(base, placed).changedNodes[0]!.fields).toEqual(["placements"]);
  });

  it("treats a legacy graph and its canonical twin as equal", () => {
    const legacy = graph([{ ...node("a"), placements: { prod: { target: "ecs", runtime: "" } } }]);
    legacy.environments = [{
      id: "prod", name: "Prod", kind: "cloud", targets: [],
      layout: { ecs: { x: 1, y: 2 } },
    }];
    expect(diffTotal(diffGraphs(legacy, normalizeDeployTargets(legacy)))).toBe(0);
  });

  it("still reports a genuine target move with placement detail", () => {
    const base = graph([{ ...node("a"), placements: { prod: { target: "ECS", targetId: "t1", runtime: "" } } }]);
    base.environments = [{ id: "prod", name: "Prod", kind: "cloud", targets: [
      { id: "t1", name: "ECS", kind: "compute" }, { id: "t2", name: "Lambda", kind: "serverless" },
    ] }];
    const target = structuredClone(base);
    target.nodes[0]!.placements.prod = { target: "Lambda", targetId: "t2", runtime: "" };
    expect(diffGraphs(base, target).changedNodes[0]!.fields).toEqual(["placements"]);
  });
});

describe("status maps", () => {
  it("index both sides for canvas decoration", () => {
    const base = graph([node("a"), node("b")], [edge("e1", "a", "b")]);
    const target = graph(
      [{ ...node("a"), label: "renamed" }, node("c")],
      [edge("e2", "a", "c")],
    );
    const diff = diffGraphs(base, target);
    const nodes = diffNodeStatus(diff);
    expect(nodes.get("a")).toBe("changed");
    expect(nodes.get("b")).toBe("removed");
    expect(nodes.get("c")).toBe("added");
    const edges = diffEdgeStatus(diff);
    expect(edges.get("e1")).toBe("removed");
    expect(edges.get("e2")).toBe("added");
  });
});
