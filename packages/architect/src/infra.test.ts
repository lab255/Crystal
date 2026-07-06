import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";
import { groupLayer, infraGroups, knownTargets, layerBands, placedEdges } from "./infra.js";

function node(id: string, kind: ArchNode["kind"], placements: ArchNode["placements"] = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), id, placements };
}

function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), nodes, edges };
}

const ecs = { target: "aws / ecs", runtime: "fargate" };
const vercel = { target: "vercel", runtime: "" };

describe("infraGroups", () => {
  it("groups placed components by target and lists the rest as unplaced", () => {
    const g = graph([
      node("api", "service", { prod: ecs }),
      node("worker", "service", { prod: ecs }),
      node("web", "frontend", { prod: vercel }),
      node("db", "datastore"),
      node("grp", "group"), // containers never appear
      node("memo", "note"), // notes never appear
    ]);
    const { groups, unplaced } = infraGroups(g, "prod");
    expect(groups.map((x) => [x.target, x.nodes.map((n) => n.id)])).toEqual([
      ["aws / ecs", ["api", "worker"]],
      ["vercel", ["web"]],
    ]);
    expect(unplaced.map((n) => n.id)).toEqual(["db"]);
  });

  it("treats a placement in another environment as unplaced here", () => {
    const g = graph([node("api", "service", { staging: ecs })]);
    const { groups, unplaced } = infraGroups(g, "prod");
    expect(groups).toEqual([]);
    expect(unplaced.map((n) => n.id)).toEqual(["api"]);
  });
});

describe("placedEdges", () => {
  it("keeps only edges with both endpoints placed", () => {
    const g = graph(
      [node("a", "service", { prod: ecs }), node("b", "service", { prod: vercel }), node("c", "service")],
      [
        { id: "e1", source: "a", target: "b", kind: "sync", label: "" },
        { id: "e2", source: "a", target: "c", kind: "sync", label: "" },
      ],
    );
    expect(placedEdges(g, "prod").map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("layerBands", () => {
  it("orders target groups entry → service → data → unlayered by majority layer", () => {
    const bands = layerBands([
      { target: "postgres", nodes: [node("db", "datastore"), node("q", "queue")] },
      { target: "vercel", nodes: [node("web", "frontend")] },
      { target: "ecs", nodes: [node("api", "service"), node("worker", "service"), node("cache", "datastore")] },
      { target: "misc", nodes: [node("memo", "external", {})] }, // external → entry
    ]);
    expect(bands.map((b) => [b.layer, b.groups.map((g) => g.target)])).toEqual([
      ["entry", ["vercel", "misc"]],
      ["service", ["ecs"]],
      ["data", ["postgres"]],
    ]);
  });

  it("respects explicit layer overrides via groupLayer", () => {
    const middleware = { ...node("mw", "service"), layer: "entry" as const };
    expect(groupLayer({ target: "edge", nodes: [middleware] })).toBe("entry");
  });
});

describe("knownTargets", () => {
  it("collects targets across all environments, deduplicated and sorted", () => {
    const g = graph([
      node("a", "service", { prod: ecs, staging: ecs }),
      node("b", "frontend", { prod: vercel }),
    ]);
    expect(knownTargets(g)).toEqual(["aws / ecs", "vercel"]);
  });
});
