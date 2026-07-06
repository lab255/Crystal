import { z } from "zod";
import {
  ArchitectureGraphSchema,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";
import { uid } from "./ids.js";

/**
 * Architecture draft — a proposed rearrangement of an architecture graph,
 * edited without touching the real diagram until applied.
 *
 * A draft carries a `base` snapshot of the graph it was branched from, so a
 * saved draft can later be restored and, when the underlying architecture has
 * moved on, *rebased*: the draft's changes (relative to `base`) are replayed
 * onto the current graph three-way-merge style. Drafts are persisted to
 * `.crystal/architecture/drafts/*.json`.
 */

export const ArchDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Workspace-relative path of the architecture file this drafts. */
  archPath: z.string(),
  /** Snapshot of the architecture graph at branch (or last rebase) time. */
  base: ArchitectureGraphSchema,
  /** The draft's working graph. */
  graph: ArchitectureGraphSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArchDraft = z.infer<typeof ArchDraftSchema>;

export function createArchDraft(
  name: string,
  archPath: string,
  graph: ArchitectureGraph,
  now: string,
): ArchDraft {
  const clone = (g: ArchitectureGraph) => JSON.parse(JSON.stringify(g)) as ArchitectureGraph;
  return {
    id: uid("draft"),
    name,
    archPath,
    base: clone(graph),
    graph: clone(graph),
    createdAt: now,
    updatedAt: now,
  };
}

/** Structural equality of graph content (viewport excluded, order-insensitive). */
export function graphsEqual(a: ArchitectureGraph, b: ArchitectureGraph): boolean {
  const norm = (g: ArchitectureGraph) =>
    JSON.stringify({
      name: g.name,
      description: g.description,
      nodes: [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...g.edges].sort((x, y) => x.id.localeCompare(y.id)),
      environments: g.environments,
    });
  return norm(a) === norm(b);
}

export interface RebaseResult {
  graph: ArchitectureGraph;
  /** Human-readable notes for changes that could not merge cleanly. */
  conflicts: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Node fields merged individually (geometry is handled as one unit). */
const NODE_FIELDS = [
  "kind",
  "label",
  "description",
  "tech",
  "repoId",
  "codeModule",
  "href",
  "accent",
  "placements",
] as const;

function geometry(n: ArchNode) {
  return { position: n.position, parentId: n.parentId ?? null, size: n.size ?? null };
}

function nodeChanged(a: ArchNode, b: ArchNode): boolean {
  return (
    NODE_FIELDS.some((k) => !same(a[k], b[k])) || !same(geometry(a), geometry(b))
  );
}

/**
 * Three-way merge: replay the draft's changes (base → ours) onto `theirs`
 * (the current graph). Where both sides changed the same thing, the draft
 * wins and a conflict note is recorded; upstream deletions of nodes the draft
 * touched are also surfaced.
 */
export function mergeGraphs(
  base: ArchitectureGraph,
  ours: ArchitectureGraph,
  theirs: ArchitectureGraph,
): RebaseResult {
  const conflicts: string[] = [];
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const ourNodes = new Map(ours.nodes.map((n) => [n.id, n]));
  const theirNodes = new Map(theirs.nodes.map((n) => [n.id, n]));

  const nodes: ArchNode[] = [];
  for (const t of theirs.nodes) {
    const b = baseNodes.get(t.id);
    if (!b) {
      nodes.push(t); // added upstream — keep
      continue;
    }
    const o = ourNodes.get(t.id);
    if (!o) {
      // Deleted in the draft. Honor the deletion unless upstream also
      // modified the node — then keep upstream's version and flag it.
      if (nodeChanged(b, t)) {
        conflicts.push(`kept "${t.label}" — deleted in draft but changed upstream`);
        nodes.push(t);
      }
      continue;
    }
    let merged: ArchNode = { ...t };
    for (const key of NODE_FIELDS) {
      if (same(o[key], b[key])) continue; // draft didn't touch this field
      if (!same(t[key], b[key]) && !same(t[key], o[key])) {
        conflicts.push(`"${o.label}": ${key} changed in draft and upstream — draft wins`);
      }
      merged = { ...merged, [key]: o[key] };
    }
    if (!same(geometry(o), geometry(b))) {
      merged = {
        ...merged,
        position: o.position,
        parentId: o.parentId ?? null,
        size: o.size ?? null,
      };
    }
    nodes.push(merged);
  }
  // Nodes added by the draft.
  for (const o of ours.nodes) {
    if (!baseNodes.has(o.id) && !theirNodes.has(o.id)) nodes.push(o);
  }
  // Draft modified a node that upstream deleted — the change is lost.
  for (const [id, b] of baseNodes) {
    const o = ourNodes.get(id);
    if (o && !theirNodes.has(id) && nodeChanged(b, o)) {
      conflicts.push(`"${o.label}" was removed upstream — draft changes to it were dropped`);
    }
  }
  // Parents that didn't survive the merge: detach instead of orphaning.
  const ids = new Set(nodes.map((n) => n.id));
  const fixedNodes = nodes.map((n) =>
    n.parentId && !ids.has(n.parentId) ? { ...n, parentId: null } : n,
  );

  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  const ourEdges = new Map(ours.edges.map((e) => [e.id, e]));
  const edges: ArchEdge[] = [];
  const pairs = new Set<string>();
  const pushEdge = (e: ArchEdge) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return; // endpoint gone
    const pair = `${e.source}->${e.target}`;
    if (pairs.has(pair)) return; // same connection added on both sides
    pairs.add(pair);
    edges.push(e);
  };
  for (const t of theirs.edges) {
    const b = baseEdges.get(t.id);
    if (!b) {
      pushEdge(t); // added upstream
      continue;
    }
    const o = ourEdges.get(t.id);
    if (!o) continue; // deleted in draft
    const merged: ArchEdge = { ...t };
    if (!same(o.kind, b.kind)) merged.kind = o.kind;
    if (!same(o.label, b.label)) merged.label = o.label;
    pushEdge(merged);
  }
  for (const o of ours.edges) {
    if (!baseEdges.has(o.id)) pushEdge(o); // added in draft
  }

  const environments = same(ours.environments, base.environments)
    ? theirs.environments
    : ours.environments;

  return {
    graph: {
      ...theirs,
      name: ours.name !== base.name ? ours.name : theirs.name,
      description: ours.description !== base.description ? ours.description : theirs.description,
      environments,
      nodes: fixedNodes,
      edges,
      viewport: ours.viewport ?? theirs.viewport,
    },
    conflicts,
  };
}

/**
 * Rebase a draft onto the latest graph: merge its changes onto `current` and
 * reset its base to `current`, so applying the draft later is a clean write.
 */
export function rebaseDraft(
  draft: ArchDraft,
  current: ArchitectureGraph,
  now: string,
): { draft: ArchDraft; conflicts: string[] } {
  const { graph, conflicts } = mergeGraphs(draft.base, draft.graph, current);
  return {
    draft: { ...draft, base: current, graph, updatedAt: now },
    conflicts,
  };
}
