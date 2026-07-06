import { z } from "zod";
import { uid } from "./ids.js";

/**
 * Architecture model.
 *
 * A graph of nodes (systems, services, repos, datastores, …) and edges
 * (sync/async/data flows). Nodes can nest arbitrarily via `parentId` —
 * a `group`/`system` node acts as a container that children can be dragged
 * into and out of. This maps 1:1 onto react-flow's subflow model but is
 * renderer-agnostic: it is the durable, versionable format written to
 * `.crystal/architecture/*.json`.
 */

export const ARCH_NODE_KINDS = [
  "system",
  "group",
  "service",
  "repo",
  "datastore",
  "queue",
  "gateway",
  "frontend",
  "external",
  "note",
] as const;

export const ArchNodeKindSchema = z.enum(ARCH_NODE_KINDS);
export type ArchNodeKind = z.infer<typeof ArchNodeKindSchema>;

/** Kinds that render as containers and may hold children. */
export const CONTAINER_KINDS: readonly ArchNodeKind[] = ["system", "group"];

/** A deployment environment the architecture runs in (dev/staging/prod…). */
export const ArchEnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type ArchEnvironment = z.infer<typeof ArchEnvironmentSchema>;

/** Where a component runs within one environment. */
export const ArchPlacementSchema = z.object({
  /** Deployment target grouping, e.g. "aws us-east-1 / ecs", "vercel", "on-prem". */
  target: z.string(),
  /** Runtime detail, e.g. "fargate ×3", "k8s deployment", "lambda". */
  runtime: z.string().default(""),
});
export type ArchPlacement = z.infer<typeof ArchPlacementSchema>;

export const ArchNodeSchema = z.object({
  id: z.string(),
  kind: ArchNodeKindSchema,
  label: z.string(),
  description: z.string().default(""),
  /** Parent container node id; null/absent at root level. */
  parentId: z.string().nullish(),
  position: z.object({ x: z.number(), y: z.number() }),
  /** Only meaningful for container kinds; leaf nodes size to content. */
  size: z.object({ width: z.number(), height: z.number() }).nullish(),
  /** Freeform tech tags, e.g. ["rust", "postgres", "ecs"]. */
  tech: z.array(z.string()).default([]),
  /** Link to a repo in the workspace manifest (by repo id). */
  repoId: z.string().nullish(),
  /**
   * Link to a code-map module (module path within this workspace, e.g.
   * "packages/core"). Drives the live code overlay on the diagram.
   */
  codeModule: z.string().nullish(),
  /** External URL (dashboard, docs, repo…). */
  href: z.string().nullish(),
  /** Environment id → where this component runs (infrastructure view). */
  placements: z.record(ArchPlacementSchema).default({}),
  /** Accent color token override (named token, not raw css). */
  accent: z
    .enum(["violet", "cyan", "emerald", "amber", "rose", "blue", "slate"])
    .nullish(),
});
export type ArchNode = z.infer<typeof ArchNodeSchema>;

export const ARCH_EDGE_KINDS = ["sync", "async", "data", "dependency"] as const;
export const ArchEdgeKindSchema = z.enum(ARCH_EDGE_KINDS);
export type ArchEdgeKind = z.infer<typeof ArchEdgeKindSchema>;

export const ArchEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: ArchEdgeKindSchema.default("sync"),
  label: z.string().default(""),
});
export type ArchEdge = z.infer<typeof ArchEdgeSchema>;

export const ArchitectureGraphSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  nodes: z.array(ArchNodeSchema).default([]),
  edges: z.array(ArchEdgeSchema).default([]),
  /** Deployment environments for the infrastructure view. */
  environments: z.array(ArchEnvironmentSchema).default([]),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number() })
    .nullish(),
});
export type ArchitectureGraph = z.infer<typeof ArchitectureGraphSchema>;

export function createArchitectureGraph(name: string): ArchitectureGraph {
  return { id: uid("arch"), name, description: "", nodes: [], edges: [], environments: [] };
}

export function createArchNode(
  kind: ArchNodeKind,
  label: string,
  position: { x: number; y: number },
  parentId?: string | null,
): ArchNode {
  return ArchNodeSchema.parse({
    id: uid("node"),
    kind,
    label,
    position,
    parentId: parentId ?? null,
    size: CONTAINER_KINDS.includes(kind) ? { width: 420, height: 280 } : null,
  });
}

export function isContainerKind(kind: ArchNodeKind): boolean {
  return CONTAINER_KINDS.includes(kind);
}

/** Set or clear (`placement: null`) a node's placement in one environment. */
export function updateNodePlacement(
  graph: ArchitectureGraph,
  nodeId: string,
  envId: string,
  placement: ArchPlacement | null,
): ArchitectureGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      if (!placement) {
        const { [envId]: _, ...rest } = n.placements;
        return { ...n, placements: rest };
      }
      return { ...n, placements: { ...n.placements, [envId]: placement } };
    }),
  };
}

/** All transitive children of `nodeId`. */
export function descendantsOf(graph: ArchitectureGraph, nodeId: string): ArchNode[] {
  const out: ArchNode[] = [];
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of graph.nodes) {
      if (n.parentId === cur) {
        out.push(n);
        stack.push(n.id);
      }
    }
  }
  return out;
}

/** True if `candidateParent` is `nodeId` itself or nested inside it (would create a cycle). */
export function wouldCreateCycle(
  graph: ArchitectureGraph,
  nodeId: string,
  candidateParent: string,
): boolean {
  if (nodeId === candidateParent) return true;
  return descendantsOf(graph, nodeId).some((n) => n.id === candidateParent);
}

/**
 * Nodes ordered parents-before-children (react-flow requires parent nodes to
 * appear before their children in the array).
 */
export function topoOrderNodes(graph: ArchitectureGraph): ArchNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ArchNode[] = [];
  const seen = new Set<string>();
  const visit = (n: ArchNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (n.parentId) {
      const parent = byId.get(n.parentId);
      if (parent) visit(parent);
    }
    out.push(n);
  };
  for (const n of graph.nodes) visit(n);
  return out;
}
