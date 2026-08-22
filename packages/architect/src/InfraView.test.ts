import { describe, expect, it } from "vitest";
import { createArchNode, createArchitectureGraph } from "@crystal/core";
import { removeZoneFromEnvironment } from "./InfraView.js";

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

describe("removeZoneFromEnvironment", () => {
  it("rebases pins in the scoped environment when another environment retains the zone", () => {
    const result = removeZoneFromEnvironment(fixture(true), "a", "zone");
    expect(result.nodes.some((node) => node.id === "zone")).toBe(true);
    expect(result.environments[0]?.targets?.[0]).toMatchObject({ x: 112, y: 234, zone: undefined });
  });

  it("fully deletes a last-reference zone and rebases its pin", () => {
    const result = removeZoneFromEnvironment(fixture(false), "a", "zone");
    expect(result.nodes.some((node) => node.id === "zone")).toBe(false);
    expect(result.environments[0]?.targets?.[0]).toMatchObject({ x: 112, y: 234, zone: undefined });
  });
});
