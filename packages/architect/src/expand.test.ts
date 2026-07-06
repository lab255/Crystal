import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchitectureGraph,
  type CodeModuleDetail,
} from "@crystal/core";
import { collapseNode, expandNodeIntoCode, hasGeneratedChildren } from "./expand.js";

function graphWithNode(): { graph: ArchitectureGraph; nodeId: string } {
  const base = createArchitectureGraph("Test");
  const node = { ...createArchNode("service", "core", { x: 40, y: 40 }), codeModule: "packages/core" };
  const other = createArchNode("frontend", "web", { x: 400, y: 40 });
  return {
    graph: {
      ...base,
      nodes: [node, other],
      edges: [{ id: "e1", source: node.id, target: other.id, kind: "sync", label: "" }],
    },
    nodeId: node.id,
  };
}

function detailWithFiles(paths: string[]): CodeModuleDetail {
  const files = paths.map((p) => {
    const inModule = p.replace(/^packages\/core\//, "");
    const dir = inModule.includes("/") ? inModule.slice(0, inModule.lastIndexOf("/")) : "";
    return {
      path: p,
      name: p.split("/").pop()!,
      dir,
      importCount: 0,
      exportCount: 1,
    };
  });
  return {
    module: { path: "packages/core", name: "@crystal/core", fileCount: files.length },
    files,
    edges: [],
    moduleDeps: [],
    truncated: false,
  };
}

describe("expandNodeIntoCode", () => {
  it("materializes file children with codeFile links and import edges", () => {
    const { graph, nodeId } = graphWithNode();
    const detail = detailWithFiles(["packages/core/src/a.ts", "packages/core/src/b.ts"]);
    detail.edges = [{ source: "packages/core/src/a.ts", target: "packages/core/src/b.ts" }];

    const expanded = expandNodeIntoCode(graph, nodeId, detail);
    const children = expanded.nodes.filter((n) => n.parentId === nodeId);
    expect(children).toHaveLength(2);
    expect(children.every((n) => n.generated)).toBe(true);
    expect(children.map((n) => n.codeFile).sort()).toEqual([
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
    ]);
    const [a, b] = children;
    expect(expanded.edges.some((e) => e.source === a!.id && e.target === b!.id && e.kind === "data")).toBe(true);
    expect(hasGeneratedChildren(expanded, nodeId)).toBe(true);
  });

  it("converts a leaf into a container and remembers the original kind", () => {
    const { graph, nodeId } = graphWithNode();
    const expanded = expandNodeIntoCode(graph, nodeId, detailWithFiles(["packages/core/src/a.ts"]));
    const container = expanded.nodes.find((n) => n.id === nodeId)!;
    expect(container.kind).toBe("group");
    expect(container.expandedFrom).toBe("service");
    expect(container.size).toBeTruthy();
    // Children fit inside the resized container.
    for (const child of expanded.nodes.filter((n) => n.parentId === nodeId)) {
      expect(child.position.x + 200).toBeLessThanOrEqual(container.size!.width);
      expect(child.position.y + 84).toBeLessThanOrEqual(container.size!.height);
    }
  });

  it("clusters by top-level directory when the module is large", () => {
    const paths = Array.from({ length: 30 }, (_, i) =>
      i < 15 ? `packages/core/src/models/m${i}.ts` : `packages/core/src/utils/u${i}.ts`,
    );
    const detail = detailWithFiles([...paths, "packages/core/index.ts"]);
    detail.edges = [
      { source: "packages/core/src/models/m0.ts", target: "packages/core/src/utils/u15.ts" },
      { source: "packages/core/src/models/m1.ts", target: "packages/core/src/utils/u16.ts" },
    ];
    const { graph, nodeId } = graphWithNode();
    const expanded = expandNodeIntoCode(graph, nodeId, detail);
    const children = expanded.nodes.filter((n) => n.parentId === nodeId);
    expect(children.map((n) => n.label).sort()).toEqual(["(root)", "src/"]);
    expect(children.every((n) => !n.codeFile)).toBe(true);
    // Both aggregated edges stay inside src/ so no cross-cluster edge exists.
    const ids = new Set(children.map((n) => n.id));
    expect(expanded.edges.filter((e) => ids.has(e.source) && ids.has(e.target))).toHaveLength(0);
  });

  it("does not move unrelated nodes", () => {
    const { graph, nodeId } = graphWithNode();
    const other = graph.nodes.find((n) => n.id !== nodeId)!;
    const expanded = expandNodeIntoCode(graph, nodeId, detailWithFiles(["packages/core/src/a.ts"]));
    expect(expanded.nodes.find((n) => n.id === other.id)!.position).toEqual(other.position);
  });

  it("re-expanding replaces previously generated children", () => {
    const { graph, nodeId } = graphWithNode();
    const once = expandNodeIntoCode(graph, nodeId, detailWithFiles(["packages/core/src/a.ts"]));
    const twice = expandNodeIntoCode(once, nodeId, detailWithFiles(["packages/core/src/b.ts"]));
    const children = twice.nodes.filter((n) => n.parentId === nodeId);
    expect(children.map((n) => n.codeFile)).toEqual(["packages/core/src/b.ts"]);
  });
});

describe("collapseNode", () => {
  it("round-trips back to the original leaf and drops generated edges", () => {
    const { graph, nodeId } = graphWithNode();
    const detail = detailWithFiles(["packages/core/src/a.ts", "packages/core/src/b.ts"]);
    detail.edges = [{ source: "packages/core/src/a.ts", target: "packages/core/src/b.ts" }];
    const collapsed = collapseNode(expandNodeIntoCode(graph, nodeId, detail), nodeId);

    const node = collapsed.nodes.find((n) => n.id === nodeId)!;
    expect(node.kind).toBe("service");
    expect(node.expandedFrom).toBeNull();
    expect(node.size).toBeNull();
    expect(collapsed.nodes.filter((n) => n.parentId === nodeId)).toHaveLength(0);
    expect(collapsed.edges).toHaveLength(1); // only the original hand-drawn edge
    expect(hasGeneratedChildren(collapsed, nodeId)).toBe(false);
  });

  it("keeps user-added children that were dragged into the expansion", () => {
    const { graph, nodeId } = graphWithNode();
    const expanded = expandNodeIntoCode(graph, nodeId, detailWithFiles(["packages/core/src/a.ts"]));
    const manual = createArchNode("note", "remember", { x: 10, y: 10 }, nodeId);
    const withManual = { ...expanded, nodes: [...expanded.nodes, manual] };
    const collapsed = collapseNode(withManual, nodeId);
    expect(collapsed.nodes.some((n) => n.id === manual.id)).toBe(true);
    // Still a container — a manual child keeps it from reverting to a leaf.
    expect(collapsed.nodes.find((n) => n.id === nodeId)!.kind).toBe("group");
  });
});
