import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";
import {
  environmentPlacementCount,
  environmentSubgraph,
  groupLayer,
  infraGroups,
  infraTargetEdges,
  isEditableDeleteTarget,
  knownTargets,
  layerBands,
  placedEdges,
  targetMemberColumns,
  zoneNestingRejection,
} from "./infra.js";

function node(id: string, kind: ArchNode["kind"], placements: ArchNode["placements"] = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), id, placements };
}

const targets = [
  { id: "tgt_ecs", name: "aws / ecs", kind: "compute" as const },
  { id: "tgt_vercel", name: "vercel", kind: "paas" as const },
  { id: "tgt_postgres", name: "postgres", kind: "compute" as const },
  { id: "tgt_misc", name: "misc", kind: "other" as const },
];
function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), environments: [{ id: "prod", name: "Prod", kind: "cloud", targets }, { id: "staging", name: "Staging", kind: "cloud", targets }], nodes, edges };
}

const ecs = { targetId: "tgt_ecs", target: "aws / ecs", runtime: "fargate" };
const vercel = { targetId: "tgt_vercel", target: "vercel", runtime: "" };

describe("infraGroups", () => {
  it("groups placed components by target and lists the rest as unplaced", () => {
    const g = graph([
      node("api", "service", { prod: ecs }),
      node("worker", "service", { prod: ecs }),
      node("web", "frontend", { prod: vercel }),
      node("db", "datastore"),
      node("grp", "group"), // containers never appear
      node("vpc", "vpc"), // deployment zones never appear as components
      node("subnet", "subnet"),
      node("sg", "securitygroup"),
      node("memo", "note"), // notes never appear
    ]);
    const { groups, unplaced } = infraGroups(g, "prod");
    expect(groups.map((x) => [x.target.id, x.nodes.map((n) => n.id)])).toEqual([
      ["tgt_ecs", ["api", "worker"]],
      ["tgt_misc", []],
      ["tgt_postgres", []],
      ["tgt_vercel", ["web"]],
    ]);
    expect(unplaced.map((n) => n.id)).toEqual(["db"]);
  });

  it("treats a placement in another environment as unplaced here", () => {
    const g = graph([node("api", "service", { staging: ecs })]);
    const { groups, unplaced } = infraGroups(g, "prod");
    expect(groups.map((group) => [group.target.id, group.nodes])).toEqual([
      ["tgt_ecs", []],
      ["tgt_misc", []],
      ["tgt_postgres", []],
      ["tgt_vercel", []],
    ]);
    expect(unplaced.map((n) => n.id)).toEqual(["api"]);
  });
});

describe("fallback target packing", () => {
  it("uses the viewport aspect to grow beyond three member columns", () => {
    expect(targetMemberColumns(24, 4, { width: 190, height: 58 })).toBe(5);
    expect(targetMemberColumns(24, 0.8, { width: 190, height: 58 })).toBe(2);
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

describe("infraTargetEdges", () => {
  it("aggregates stable target pairs and drops within-target dependencies", () => {
    const g = graph(
      [
        node("a", "service", { prod: ecs }),
        node("b", "service", { prod: ecs }),
        node("c", "service", { prod: vercel }),
      ],
      [
        { id: "z", source: "b", target: "c", kind: "sync", label: "" },
        { id: "a", source: "a", target: "c", kind: "sync", label: "" },
        { id: "self", source: "a", target: "b", kind: "sync", label: "" },
      ],
    );
    expect(infraTargetEdges(g, "prod")).toEqual([
      { id: "tgt_ecs->tgt_vercel", source: "tgt_ecs", target: "tgt_vercel" },
    ]);
  });
});

describe("environmentSubgraph", () => {
  it("keeps placed components and only edges induced by them", () => {
    const g = graph(
      [node("a", "service", { prod: ecs }), node("b", "service", { prod: vercel }), node("c", "note", { prod: ecs }), node("d", "service")],
      [{ id: "ab", source: "a", target: "b", kind: "sync", label: "" }, { id: "ad", source: "a", target: "d", kind: "sync", label: "" }],
    );
    const scoped = environmentSubgraph(g, "prod");
    expect(scoped.nodes.map((item) => item.id)).toEqual(["a", "b"]);
    expect(scoped.edges.map((edge) => edge.id)).toEqual(["ab"]);
    expect(scoped.environments).toBe(g.environments);
  });
});

describe("layerBands", () => {
  it("orders target groups entry → service → data → unlayered by majority layer", () => {
    const bands = layerBands([
      { target: targets[2]!, nodes: [node("db", "datastore"), node("q", "queue")] },
      { target: targets[1]!, nodes: [node("web", "frontend")] },
      { target: targets[0]!, nodes: [node("api", "service"), node("worker", "service"), node("cache", "datastore")] },
      { target: targets[3]!, nodes: [node("memo", "external", {})] }, // external → entry
    ]);
    expect(bands.map((b) => [b.layer, b.groups.map((g) => g.target.name)])).toEqual([
      ["entry", ["vercel", "misc"]],
      ["service", ["aws / ecs"]],
      ["data", ["postgres"]],
    ]);
  });

  it("respects explicit layer overrides via groupLayer", () => {
    const middleware = { ...node("mw", "service"), layer: "entry" as const };
    expect(groupLayer({ target: targets[3]!, nodes: [middleware] })).toBe("entry");
  });

  it("gives declared-but-empty targets a stable band from their kind", () => {
    expect(groupLayer({ target: { id: "lambda", name: "Lambda", kind: "serverless" }, nodes: [] })).toBe("service");
    expect(groupLayer({ target: { id: "cdn", name: "CDN", kind: "edge" }, nodes: [] })).toBe("entry");
    expect(groupLayer({ target: { id: "phone", name: "Phone", kind: "device" }, nodes: [] })).toBe("entry");
    expect(groupLayer({ target: { id: "misc", name: "Misc", kind: "other" }, nodes: [] })).toBeNull();
  });
});

describe("knownTargets", () => {
  it("collects targets across all environments, deduplicated and sorted", () => {
    const g = graph([
      node("a", "service", { prod: ecs, staging: ecs }),
      node("b", "frontend", { prod: vercel }),
    ]);
    expect(knownTargets(g).map((target) => target.id)).toEqual(["tgt_ecs", "tgt_misc", "tgt_postgres", "tgt_vercel"]);
  });
});

describe("destructive deployment edits", () => {
  it("counts every placement an environment removal will destroy", () => {
    const g = graph([
      node("a", "service", { prod: ecs, staging: vercel }),
      node("b", "frontend", { prod: vercel }),
      node("c", "datastore"),
    ]);
    expect(environmentPlacementCount(g, "prod")).toBe(2);
    expect(environmentPlacementCount(g, "staging")).toBe(1);
  });

  it("explains rejected zone nesting narrowly", () => {
    expect(zoneNestingRejection("vpc", "subnet")).toBe("A VPC cannot be nested inside a subnet.");
    expect(zoneNestingRejection("subnet", "vpc")).toBeNull();
    expect(zoneNestingRejection("namespace", "cluster")).toBeNull();
    expect(zoneNestingRejection("zone", "region")).toBeNull();
  });
});

describe("deployment delete guard", () => {
  it("recognizes editable controls and contenteditable descendants", () => {
    const target = (matches: boolean, insideEditable = false) => ({
      matches: () => matches,
      closest: () => insideEditable ? {} : null,
    }) as unknown as EventTarget;
    expect(isEditableDeleteTarget(target(true))).toBe(true);
    expect(isEditableDeleteTarget(target(false, true))).toBe(true);
    expect(isEditableDeleteTarget(target(false))).toBe(false);
  });
});
