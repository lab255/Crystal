import { describe, expect, it } from "vitest";
import { createArchNode, createArchitectureGraph } from "@crystal/core";
import { infraGroupSceneNode, isInfraDropTarget, removeInfraNodeFromEnvironment } from "./InfraView.js";

function fixture(shared: boolean) {
  const zone = { ...createArchNode("zone", "Zone", { x: 100, y: 200 }), id: "zone" };
  return {
    ...createArchitectureGraph("test"),
    nodes: [zone],
    environments: [
      { id: "a", name: "A", kind: "cloud" as const, infraNodeIds: ["zone"], targets: [{ id: "t", name: "Target", kind: "other" as const, zone: "zone", x: 12, y: 34 }] },
      { id: "b", name: "B", kind: "cloud" as const, infraNodeIds: shared ? ["zone"] : [], targets: [] },
    ],
  };
}

describe("removeInfraNodeFromEnvironment", () => {
  it("rebases pins in the scoped environment when another environment retains the zone", () => {
    const result = removeInfraNodeFromEnvironment(fixture(true), "a", "zone");
    expect(result.nodes.some((node) => node.id === "zone")).toBe(true);
    expect(result.environments[0]?.targets?.[0]).toMatchObject({ x: 112, y: 234, zone: undefined });
  });

  it("fully deletes a last-reference zone and rebases its pin", () => {
    const result = removeInfraNodeFromEnvironment(fixture(false), "a", "zone");
    expect(result.nodes.some((node) => node.id === "zone")).toBe(false);
    expect(result.environments[0]?.targets?.[0]).toMatchObject({ x: 112, y: 234, zone: undefined });
  });

  it("removes a note reference before deleting the last-reference node and touching edges", () => {
    const graph = fixture(true);
    graph.nodes.push({ ...createArchNode("note", "Memo", { x: 0, y: 0 }), id: "note" });
    graph.nodes.push({ ...createArchNode("service", "API", { x: 0, y: 0 }), id: "api" });
    graph.environments[0]!.infraNodeIds!.push("note");
    graph.environments[1]!.infraNodeIds!.push("note");
    graph.edges.push({ id: "edge", source: "note", target: "api", kind: "dependency", label: "" });
    const shared = removeInfraNodeFromEnvironment(graph, "a", "note");
    expect(shared.nodes.some((node) => node.id === "note")).toBe(true);
    const removed = removeInfraNodeFromEnvironment(shared, "b", "note");
    expect(removed.nodes.some((node) => node.id === "note")).toBe(false);
    expect(removed.edges).toEqual([]);
  });
});

describe("deployment target scene", () => {
  it("renders a declared empty target as a minimum-size component drop target", () => {
    const target = fixture(false).environments[0]!.targets![0]!;
    const sceneNode = infraGroupSceneNode(
      { target, nodes: [] },
      { x: 48, y: 96 },
      { width: 218, height: 118 },
      { local: false, selected: false, simActive: false },
    );
    expect(sceneNode).toMatchObject({
      id: "target:t",
      type: "infragroup",
      width: 218,
      height: 118,
      data: { targetId: "t", count: 0, memberIds: [] },
    });
    expect(isInfraDropTarget(sceneNode)).toBe(true);
  });
});
