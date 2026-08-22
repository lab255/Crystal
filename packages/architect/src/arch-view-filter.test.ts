import { describe, expect, it } from "vitest";
import { createArchNode, createArchitectureGraph } from "@crystal/core";
import { reinjectInfraOnly, splitInfraOnly } from "./arch-view-filter.js";

describe("architecture infra-only projection", () => {
  it("removes zones, defensive descendants, and incident edges", () => {
    const service = { ...createArchNode("service", "Service", { x: 1, y: 2 }), id: "svc" };
    const zone = { ...createArchNode("vpc", "VPC", { x: 30, y: 40 }), id: "vpc" };
    const child = { ...createArchNode("service", "Defensive child", { x: 3, y: 4 }), id: "child", parentId: "vpc" };
    const graph = {
      ...createArchitectureGraph("test"),
      nodes: [service, zone, child],
      edges: [{ id: "edge", source: "svc", target: "child", kind: "sync" as const, label: "" }],
    };
    const { view, infraOnly } = splitInfraOnly(graph);
    expect(view.nodes.map((node) => node.id)).toEqual(["svc"]);
    expect(view.edges).toEqual([]);
    expect(infraOnly.nodes.map((node) => node.id)).toEqual(["vpc", "child"]);
    expect(infraOnly.edges.map((edge) => edge.id)).toEqual(["edge"]);
  });

  it("reinjects preserved positions without duplicating ids", () => {
    const zone = { ...createArchNode("region", "Region", { x: 30, y: 40 }), id: "region" };
    const edited = { ...createArchitectureGraph("test"), nodes: [zone, { ...createArchNode("service", "A", { x: 9, y: 8 }), id: "a" }] };
    const result = reinjectInfraOnly(edited, { nodes: [zone], edges: [] });
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "region"]);
    expect(result.nodes[1]?.position).toEqual({ x: 30, y: 40 });
  });

  it("preserves a manual edge from a service to a zone across the projection round-trip", () => {
    const service = { ...createArchNode("service", "Service", { x: 1, y: 2 }), id: "svc" };
    const zone = { ...createArchNode("zone", "Zone", { x: 30, y: 40 }), id: "zone" };
    const edge = { id: "manual-zone-edge", source: "svc", target: "zone", kind: "sync" as const, label: "runs in" };
    const graph = { ...createArchitectureGraph("test"), nodes: [service, zone], edges: [edge] };
    const { view, infraOnly } = splitInfraOnly(graph);

    expect(reinjectInfraOnly(view, infraOnly).edges).toEqual([edge]);
  });
});
