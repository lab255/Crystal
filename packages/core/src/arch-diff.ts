import type { ArchEdge, ArchNode, ArchitectureGraph } from "./architecture.js";
import { normalizeDeployTargets } from "./arch-deploy.js";

/**
 * Architecture diff — the structured difference between two graphs, built for
 * review: a draft against its base, or the architecture at a git ref against
 * the current one. Semantic changes only: node positions and sizes are layout,
 * not architecture, so pure geometry moves never show up (containment —
 * `parentId` — does count).
 */

/** Node fields the diff compares (geometry excluded, containment included). */
export const DIFF_NODE_FIELDS = [
  "kind",
  "label",
  "description",
  "parentId",
  "tech",
  "repoId",
  "codeModule",
  "codeFile",
  "href",
  "placements",
  "layer",
  "accent",
  "sim",
] as const;
export type ArchNodeDiffField = (typeof DIFF_NODE_FIELDS)[number];

export interface ArchNodeChange {
  before: ArchNode;
  after: ArchNode;
  fields: ArchNodeDiffField[];
}

export interface ArchEdgeChange {
  before: ArchEdge;
  after: ArchEdge;
  fields: ("kind" | "label")[];
}

export interface ArchDiff {
  addedNodes: ArchNode[];
  removedNodes: ArchNode[];
  changedNodes: ArchNodeChange[];
  addedEdges: ArchEdge[];
  removedEdges: ArchEdge[];
  changedEdges: ArchEdgeChange[];
}

export type ArchDiffStatus = "added" | "removed" | "changed";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Edges are identified by their connection, not their id — regenerated edges
 * (a re-seed, a ref snapshot) get fresh ids but describe the same arrow.
 */
function edgeKey(e: ArchEdge): string {
  return `${e.source}->${e.target}`;
}

/** Structured semantic diff of `base` → `target`. Nodes match by id, edges by connection. */
export function diffGraphs(base: ArchitectureGraph, target: ArchitectureGraph): ArchDiff {
  base = normalizeDeployTargets(base);
  target = normalizeDeployTargets(target);
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const targetNodes = new Map(target.nodes.map((n) => [n.id, n]));

  const addedNodes: ArchNode[] = [];
  const removedNodes: ArchNode[] = [];
  const changedNodes: ArchNodeChange[] = [];
  for (const node of target.nodes) {
    const before = baseNodes.get(node.id);
    if (!before) {
      addedNodes.push(node);
      continue;
    }
    const fields = DIFF_NODE_FIELDS.filter((f) => !same(before[f], node[f]));
    if (fields.length > 0) changedNodes.push({ before, after: node, fields });
  }
  for (const node of base.nodes) {
    if (!targetNodes.has(node.id)) removedNodes.push(node);
  }

  const baseEdges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  const targetEdges = new Map(target.edges.map((e) => [edgeKey(e), e]));

  const addedEdges: ArchEdge[] = [];
  const removedEdges: ArchEdge[] = [];
  const changedEdges: ArchEdgeChange[] = [];
  for (const [key, edge] of targetEdges) {
    const before = baseEdges.get(key);
    if (!before) {
      addedEdges.push(edge);
      continue;
    }
    const fields: ("kind" | "label")[] = [];
    if (before.kind !== edge.kind) fields.push("kind");
    if (before.label !== edge.label) fields.push("label");
    if (fields.length > 0) changedEdges.push({ before, after: edge, fields });
  }
  for (const [key, edge] of baseEdges) {
    if (!targetEdges.has(key)) removedEdges.push(edge);
  }

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, changedEdges };
}

export function diffTotal(diff: ArchDiff): number {
  return (
    diff.addedNodes.length +
    diff.removedNodes.length +
    diff.changedNodes.length +
    diff.addedEdges.length +
    diff.removedEdges.length +
    diff.changedEdges.length
  );
}

/** Per-node review status, keyed by node id (spans both sides of the diff). */
export function diffNodeStatus(diff: ArchDiff): Map<string, ArchDiffStatus> {
  const status = new Map<string, ArchDiffStatus>();
  for (const n of diff.addedNodes) status.set(n.id, "added");
  for (const n of diff.removedNodes) status.set(n.id, "removed");
  for (const c of diff.changedNodes) status.set(c.after.id, "changed");
  return status;
}

/** Per-edge review status, keyed by edge id (base-side and target-side ids both included). */
export function diffEdgeStatus(diff: ArchDiff): Map<string, ArchDiffStatus> {
  const status = new Map<string, ArchDiffStatus>();
  for (const e of diff.addedEdges) status.set(e.id, "added");
  for (const e of diff.removedEdges) status.set(e.id, "removed");
  for (const c of diff.changedEdges) {
    status.set(c.before.id, "changed");
    status.set(c.after.id, "changed");
  }
  return status;
}
