import { describe, expect, it } from "vitest";
import {
  createArchDraft,
  graphsEqual,
  mergeGraphs,
  rebaseDraft,
} from "./arch-draft.js";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";

function node(id: string, label = id, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode("service", label, { x: 0, y: 0 }), ...patch, id };
}

function edge(id: string, source: string, target: string, patch: Partial<ArchEdge> = {}): ArchEdge {
  return { id, source, target, kind: "sync", label: "", ...patch };
}

function graph(nodes: ArchNode[], edges: ArchEdge[] = []): ArchitectureGraph {
  // Deterministic: createArchitectureGraph seeds a Local env with a fresh id.
  return { ...createArchitectureGraph("g"), id: "arch_1", environments: [], nodes, edges };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("graphsEqual", () => {
  it("ignores viewport and ordering", () => {
    const a = graph([node("a"), node("b")], [edge("e1", "a", "b")]);
    const b = {
      ...clone(a),
      nodes: [...a.nodes].reverse(),
      viewport: { x: 9, y: 9, zoom: 2 },
    };
    expect(graphsEqual(a, b)).toBe(true);
  });

  it("detects node changes", () => {
    const a = graph([node("a")]);
    const b = graph([node("a", "renamed")]);
    expect(graphsEqual(a, b)).toBe(false);
  });
});

describe("mergeGraphs", () => {
  it("replays draft additions and deletions onto the current graph", () => {
    const base = graph([node("a"), node("b")], [edge("e1", "a", "b")]);
    const ours = graph([node("a"), node("c", "added")], []); // deleted b (and e1), added c
    const theirs = graph([node("a"), node("b"), node("d", "upstream")], [edge("e1", "a", "b")]);

    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    const ids = merged.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "c", "d"]);
    expect(merged.edges).toEqual([]); // e1 lost its endpoint
    expect(conflicts).toEqual([]);
  });

  it("applies draft moves while keeping upstream field edits", () => {
    const base = graph([node("a")]);
    const ours = graph([node("a", "a", { position: { x: 100, y: 50 } })]);
    const theirs = graph([node("a", "renamed upstream")]);

    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.nodes[0]!.position).toEqual({ x: 100, y: 50 });
    expect(merged.nodes[0]!.label).toBe("renamed upstream");
    expect(conflicts).toEqual([]);
  });

  it("draft wins on conflicting field edits, with a conflict note", () => {
    const base = graph([node("a", "old")]);
    const ours = graph([node("a", "draft name")]);
    const theirs = graph([node("a", "upstream name")]);

    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.nodes[0]!.label).toBe("draft name");
    expect(conflicts).toHaveLength(1);
  });

  it("keeps upstream-modified nodes the draft deleted, with a conflict note", () => {
    const base = graph([node("a"), node("b")]);
    const ours = graph([node("a")]); // deleted b
    const theirs = graph([node("a"), node("b", "b upstream-renamed")]);

    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(conflicts).toHaveLength(1);
  });

  it("flags draft edits to upstream-deleted nodes", () => {
    const base = graph([node("a"), node("b")]);
    const ours = graph([node("a"), node("b", "b draft-renamed")]);
    const theirs = graph([node("a")]); // upstream deleted b

    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(conflicts).toHaveLength(1);
  });

  it("dedupes the same connection added on both sides", () => {
    const base = graph([node("a"), node("b")]);
    const ours = graph([node("a"), node("b")], [edge("eo", "a", "b")]);
    const theirs = graph([node("a"), node("b")], [edge("et", "a", "b")]);

    const { graph: merged } = mergeGraphs(base, ours, theirs);
    expect(merged.edges).toHaveLength(1);
  });

  it("detaches children whose container did not survive the merge", () => {
    const container = { ...createArchNode("group", "grp", { x: 0, y: 0 }), id: "grp" };
    const child = node("child", "child", { parentId: "grp" });
    const base = graph([container, child]);
    const ours = graph([container, { ...child, label: "child edited" }]);
    const theirs = graph([clone(child)]); // upstream deleted the container

    const { graph: merged } = mergeGraphs(base, ours, theirs);
    const mergedChild = merged.nodes.find((n) => n.id === "child")!;
    expect(mergedChild.parentId).toBeNull();
    expect(mergedChild.label).toBe("child edited");
  });
});

describe("mergeGraphs — environments and journeys", () => {
  const env = (id: string, name = id, kind: "local" | "cloud" = "local") => ({ id, name, kind });
  const journey = (id: string, name = id, symbol = "main") => ({
    id,
    name,
    description: "",
    entry: { file: "src/app.ts", symbol },
  });

  it("takes upstream environments when the draft did not touch them", () => {
    const base = graph([]);
    const theirs = { ...graph([]), environments: [env("e1", "Local")] };
    const { graph: merged, conflicts } = mergeGraphs(base, clone(base), theirs);
    expect(merged.environments).toEqual([env("e1", "Local")]);
    expect(conflicts).toEqual([]);
  });

  it("notes a conflict when environments diverged on both sides", () => {
    const base = { ...graph([]), environments: [env("e1", "Local")] };
    const ours = { ...graph([]), environments: [env("e1", "Local"), env("e2", "AWS", "cloud")] };
    const theirs = { ...graph([]), environments: [env("e1", "Dev")] };
    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.environments).toEqual(ours.environments);
    expect(conflicts).toContain("environments changed in draft and upstream — draft wins");
  });

  it("keeps journey additions from both sides", () => {
    const base = graph([]);
    const ours = { ...graph([]), journeys: [journey("j1", "Creation")] };
    const theirs = { ...graph([]), journeys: [journey("j2", "Submission")] };
    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.journeys.map((j) => j.id).sort()).toEqual(["j1", "j2"]);
    expect(conflicts).toEqual([]);
  });

  it("draft wins when both sides edit the same journey, with a note", () => {
    const base = { ...graph([]), journeys: [journey("j1", "Creation")] };
    const ours = { ...graph([]), journeys: [journey("j1", "Creation", "createThing")] };
    const theirs = { ...graph([]), journeys: [journey("j1", "Creation", "submitThing")] };
    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.journeys[0]!.entry.symbol).toBe("createThing");
    expect(conflicts).toHaveLength(1);
  });

  it("honors journey deletions unless upstream edited the journey", () => {
    const base = { ...graph([]), journeys: [journey("j1"), journey("j2")] };
    const ours = { ...graph([]), journeys: [journey("j1")] }; // deleted j2
    const theirs = { ...graph([]), journeys: [journey("j1"), journey("j2", "j2 renamed")] };
    const { graph: merged, conflicts } = mergeGraphs(base, ours, theirs);
    expect(merged.journeys.map((j) => j.id).sort()).toEqual(["j1", "j2"]);
    expect(conflicts).toHaveLength(1);
  });
});

describe("rebaseDraft", () => {
  it("resets base to current so a later apply is a clean write", () => {
    const current = graph([node("a")]);
    const draft = createArchDraft("plan", ".crystal/architecture/x.json", graph([]), "t0");
    draft.graph = graph([node("b", "draft-added")]);

    const { draft: rebased } = rebaseDraft(draft, current, "t1");
    expect(rebased.base).toEqual(current);
    expect(rebased.graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(rebased.updatedAt).toBe("t1");
    expect(graphsEqual(rebased.base, current)).toBe(true);
  });

  it("preserves refactor intents across a rebase", () => {
    const draft = createArchDraft("plan", ".crystal/architecture/x.json", graph([]), "t0");
    draft.refactors = [
      { id: "r1", kind: "move", symbol: "helper", fromFile: "a.ts", toModule: "packages/core", toFile: null },
    ];
    const { draft: rebased } = rebaseDraft(draft, graph([node("a")]), "t1");
    expect(rebased.refactors).toEqual(draft.refactors);
  });
});

describe("ArchDraftSchema back-compat", () => {
  it("parses legacy drafts without refactors or env kinds", async () => {
    const { ArchDraftSchema } = await import("./arch-draft.js");
    const legacyGraph = {
      id: "arch_1",
      name: "g",
      nodes: [],
      edges: [],
      environments: [{ id: "e1", name: "prod" }], // no `kind`
    };
    const parsed = ArchDraftSchema.parse({
      id: "d1",
      name: "Plan",
      archPath: ".crystal/architecture/overview.json",
      base: legacyGraph,
      graph: legacyGraph,
      createdAt: "t0",
      updatedAt: "t0",
    });
    expect(parsed.refactors).toEqual([]);
    expect(parsed.graph.journeys).toEqual([]);
    expect(parsed.graph.environments[0]!.kind).toBe("local");
  });
});
