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
  "cache",
  "queue",
  "gateway",
  "loadbalancer",
  "frontend",
  "external",
  "note",
] as const;

export const ArchNodeKindSchema = z.enum(ARCH_NODE_KINDS);
export type ArchNodeKind = z.infer<typeof ArchNodeKindSchema>;

/** Kinds that render as containers and may hold children. */
export const CONTAINER_KINDS: readonly ArchNodeKind[] = ["system", "group"];

/**
 * Traffic layers for the top-down layered view: requests enter through the
 * `entry` tier (gateways, middleware, controllers, frontends), flow through
 * `service` business logic, and land in the `data` tier.
 */
export const ARCH_LAYERS = ["entry", "service", "data"] as const;
export const ArchLayerSchema = z.enum(ARCH_LAYERS);
export type ArchLayer = z.infer<typeof ArchLayerSchema>;

/** Default layer per node kind; containers and notes stay unlayered. */
export const DEFAULT_LAYER_OF_KIND: Partial<Record<ArchNodeKind, ArchLayer>> = {
  gateway: "entry",
  loadbalancer: "entry",
  frontend: "entry",
  external: "entry",
  service: "service",
  repo: "service",
  datastore: "data",
  cache: "data",
  queue: "data",
};

/** A deployment environment the architecture runs in (dev/staging/prod…). */
export const ArchEnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Local development vs deployed cloud infrastructure. */
  kind: z.enum(["local", "cloud"]).default("local"),
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

/** Load-balancing strategies for `loadbalancer` (and gateway) nodes. */
export const LB_ALGORITHMS = ["round-robin", "least-loaded", "weighted"] as const;
export const LbAlgorithmSchema = z.enum(LB_ALGORITHMS);
export type LbAlgorithm = z.infer<typeof LbAlgorithmSchema>;

/** Circuit breaker guarding a component in the traffic simulation. */
export const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Error fraction (0..1) that trips the breaker open. */
  errorThreshold: z.number().min(0).max(1).default(0.5),
  /** Ticks the breaker stays open before probing again (half-open). */
  cooldownTicks: z.number().int().min(1).default(6),
});
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Per-node knobs for the traffic simulation. Every field is optional — the
 * simulator falls back to kind-based defaults, so plain diagrams simulate
 * without any setup.
 */
export const SimNodeConfigSchema = z.object({
  /** Identical instances behind this component; capacity scales linearly. */
  replicas: z.number().int().min(1).max(999).default(1),
  /** Requests/second one replica handles before degrading; null = kind default. */
  capacityRps: z.number().positive().nullish(),
  /** Baseline processing latency per request; null = kind default. */
  latencyMs: z.number().min(0).nullish(),
  /** Cache nodes only: fraction of requests served without going downstream. */
  cacheHitRate: z.number().min(0).max(1).nullish(),
  /** How loadbalancer/gateway nodes split traffic across outgoing edges. */
  lbAlgorithm: LbAlgorithmSchema.nullish(),
  circuitBreaker: CircuitBreakerConfigSchema.nullish(),
});
export type SimNodeConfig = z.infer<typeof SimNodeConfigSchema>;

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
  /**
   * Link to a specific file (workspace-relative) — finer than `codeModule`.
   * Set on nodes materialized by "Expand code" so peeks and dataflow can
   * resolve at file granularity.
   */
  codeFile: z.string().nullish(),
  /** True on children materialized by "Expand code"; collapse removes them. */
  generated: z.boolean().optional(),
  /**
   * Original leaf kind before "Expand code" converted this node into a
   * container; collapse restores it.
   */
  expandedFrom: ArchNodeKindSchema.nullish(),
  /** External URL (dashboard, docs, repo…). */
  href: z.string().nullish(),
  /** Environment id → where this component runs (infrastructure view). */
  placements: z.record(ArchPlacementSchema).default({}),
  /** Explicit layer override; null/absent derives the layer from `kind`. */
  layer: ArchLayerSchema.nullish(),
  /** Accent color token override (named token, not raw css). */
  accent: z
    .enum(["violet", "cyan", "emerald", "amber", "rose", "blue", "slate"])
    .nullish(),
  /** Traffic-simulation overrides; absent = simulate with kind defaults. */
  sim: SimNodeConfigSchema.nullish(),
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

/**
 * A named user journey (creation, update, submission…) anchored to a code
 * entry point. The dataflow view traces the call graph from `entry` and
 * projects the flow onto the diagram — the journey stores only the anchor,
 * never the trace, so it follows the code as it changes.
 */
export const JourneySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  entry: z.object({
    /** Workspace-relative file path. */
    file: z.string(),
    /** Top-level symbol name within that file. */
    symbol: z.string(),
  }),
});
export type Journey = z.infer<typeof JourneySchema>;

export const ArchitectureGraphSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  nodes: z.array(ArchNodeSchema).default([]),
  edges: z.array(ArchEdgeSchema).default([]),
  /** Deployment environments for the infrastructure view. */
  environments: z.array(ArchEnvironmentSchema).default([]),
  /** User journeys for the dataflow view. */
  journeys: z.array(JourneySchema).default([]),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number() })
    .nullish(),
});
export type ArchitectureGraph = z.infer<typeof ArchitectureGraphSchema>;

export function createArchitectureGraph(name: string): ArchitectureGraph {
  return {
    id: uid("arch"),
    name,
    description: "",
    nodes: [],
    edges: [],
    environments: [createLocalEnvironment()],
    journeys: [],
  };
}

/** The default environment every architecture starts with. */
export function createLocalEnvironment(): ArchEnvironment {
  return { id: uid("env"), name: "Local", kind: "local" };
}

/** Effective layer of a node: explicit override, else derived from its kind. */
export function layerOfNode(node: ArchNode): ArchLayer | null {
  return node.layer ?? DEFAULT_LAYER_OF_KIND[node.kind] ?? null;
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
