import {
  createArchNode,
  descendantsOf,
  isContainerKind,
  uid,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
  type CodeModuleDetail,
} from "@crystal/core";
import { fitContainersToChildren, layoutChildrenOf } from "./layout.js";

/**
 * In-place drill-down: expand a code-linked diagram node into its module's
 * internals — one generated child per file (small modules) or per top-level
 * directory (large ones), wired with the module's real import edges. Only the
 * expanded container is touched; the rest of the diagram keeps its layout.
 * Collapse removes the generated children and restores the original leaf.
 */

/** Above this many files, children are directory clusters instead of files. */
const MAX_FILE_CHILDREN = 25;

export function hasGeneratedChildren(graph: ArchitectureGraph, nodeId: string): boolean {
  return graph.nodes.some((n) => n.parentId === nodeId && n.generated);
}

export function expandNodeIntoCode(
  graph: ArchitectureGraph,
  nodeId: string,
  detail: CodeModuleDetail,
): ArchitectureGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;

  // Re-expanding refreshes: drop any previously generated children first.
  let g = collapseNode(graph, nodeId, { keepContainer: true });

  const container: ArchNode = isContainerKind(node.kind)
    ? node
    : { ...node, kind: "group", expandedFrom: node.kind, size: node.size ?? { width: 420, height: 280 } };
  g = { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? container : n)) };

  const children: ArchNode[] = [];
  const edges: ArchEdge[] = [];
  const seenPairs = new Set<string>();
  const pushEdge = (source: string, target: string, label = "") => {
    const key = `${source}|${target}`;
    if (source === target || seenPairs.has(key)) return;
    seenPairs.add(key);
    edges.push({ id: uid("edge"), source, target, kind: "data", label });
  };

  if (detail.files.length <= MAX_FILE_CHILDREN) {
    const idByFile = new Map<string, string>();
    for (const f of detail.files) {
      const child = createArchNode("package", f.name, { x: 0, y: 0 }, nodeId);
      children.push({
        ...child,
        description: f.dir,
        codeFile: f.path,
        generated: true,
      });
      idByFile.set(f.path, child.id);
    }
    for (const e of detail.edges) {
      const source = idByFile.get(e.source);
      const target = idByFile.get(e.target);
      if (source && target) pushEdge(source, target);
    }
  } else {
    // Directory clusters: group files by the top segment of their module-
    // relative dir, aggregate the import edges between clusters.
    const clusterOf = new Map<string, string>(); // file path → cluster key
    const clusters = new Map<string, { count: number }>();
    for (const f of detail.files) {
      const key = f.dir === "" ? "." : (f.dir.split("/")[0] ?? ".");
      clusterOf.set(f.path, key);
      const c = clusters.get(key) ?? { count: 0 };
      c.count += 1;
      clusters.set(key, c);
    }
    const idByCluster = new Map<string, string>();
    for (const [key, { count }] of [...clusters.entries()].sort()) {
      const label = key === "." ? "(root)" : `${key}/`;
      const child = createArchNode("package", label, { x: 0, y: 0 }, nodeId);
      children.push({
        ...child,
        description: `${count} ${count === 1 ? "file" : "files"}`,
        generated: true,
      });
      idByCluster.set(key, child.id);
    }
    const weights = new Map<string, number>();
    for (const e of detail.edges) {
      const source = clusterOf.get(e.source);
      const target = clusterOf.get(e.target);
      if (!source || !target || source === target) continue;
      const key = `${source}|${target}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
    for (const [key, weight] of weights) {
      const [source, target] = key.split("|") as [string, string];
      pushEdge(idByCluster.get(source)!, idByCluster.get(target)!, `×${weight}`);
    }
  }

  g = { ...g, nodes: [...g.nodes, ...children], edges: [...g.edges, ...edges] };
  g = layoutChildrenOf(g, nodeId);
  return fitContainersToChildren(g, nodeId);
}

export function collapseNode(
  graph: ArchitectureGraph,
  nodeId: string,
  opts: { keepContainer?: boolean } = {},
): ArchitectureGraph {
  const removed = new Set(
    descendantsOf(graph, nodeId)
      .filter((n) => n.generated)
      .map((n) => n.id),
  );
  if (removed.size === 0 && !opts.keepContainer) return graph;
  const stillHasChildren = graph.nodes.some((n) => n.parentId === nodeId && !removed.has(n.id));
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !removed.has(n.id))
      .map((n) => {
        if (n.id !== nodeId || opts.keepContainer || !n.expandedFrom || stillHasChildren) return n;
        // Restore the pre-expansion leaf.
        return { ...n, kind: n.expandedFrom, expandedFrom: null, size: null };
      }),
    edges: graph.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
  };
}
