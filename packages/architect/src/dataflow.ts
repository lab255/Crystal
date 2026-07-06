import type {
  ArchitectureGraph,
  CodeMapSummary,
  CodeTrace,
  CodeTraceStep,
} from "@crystal/core";
import { linkNodesToModules } from "./overlay.js";

/**
 * Dataflow projection — maps a code-level call trace (one user journey) onto
 * the architecture diagram. Each trace step lives in a module; modules link
 * to diagram nodes (same linking as the code overlay); consecutive steps in
 * different nodes become numbered hops. Hops with a drawn edge decorate it;
 * hops without one render as ghost flow edges.
 */

export interface FlowProjection {
  /** Diagram nodes on the journey, with the first hop number that reaches them. */
  nodeOrder: { nodeId: string; firstStep: number }[];
  /** Drawn edge id → hop numbers travelling along it (either direction). */
  edgeSteps: Map<string, number[]>;
  /** Hops between linked nodes with no drawn edge. */
  ghostHops: { source: string; target: string; step: number }[];
  /** Trace steps whose module no diagram node is linked to. */
  unmappedSteps: CodeTraceStep[];
}

export function projectTrace(
  trace: CodeTrace,
  graph: ArchitectureGraph,
  summary: CodeMapSummary,
): FlowProjection {
  const badges = linkNodesToModules(graph, summary);
  const moduleToNode = new Map<string, string>();
  for (const [nodeId, badge] of badges) {
    if (!moduleToNode.has(badge.module)) moduleToNode.set(badge.module, nodeId);
  }

  // Trace steps arrive in BFS order — walk them as the journey's storyline,
  // collapsing consecutive steps that live in the same diagram node.
  const nodeOrder: FlowProjection["nodeOrder"] = [];
  const seenNodes = new Set<string>();
  const unmappedSteps: CodeTraceStep[] = [];
  const path: string[] = []; // node ids in visit order, deduped consecutively

  for (const step of trace.steps) {
    const nodeId = moduleToNode.get(step.module);
    if (!nodeId) {
      unmappedSteps.push(step);
      continue;
    }
    if (path[path.length - 1] !== nodeId) path.push(nodeId);
  }

  const edgeSteps = new Map<string, number[]>();
  const ghostHops: FlowProjection["ghostHops"] = [];
  const edgeBetween = (a: string, b: string) =>
    graph.edges.find(
      (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
    );

  let hop = 0;
  path.forEach((nodeId, i) => {
    if (!seenNodes.has(nodeId)) {
      seenNodes.add(nodeId);
      nodeOrder.push({ nodeId, firstStep: i === 0 ? 0 : hop + 1 });
    }
    if (i === 0) return;
    hop += 1;
    const prev = path[i - 1]!;
    const edge = edgeBetween(prev, nodeId);
    if (edge) {
      const steps = edgeSteps.get(edge.id) ?? [];
      steps.push(hop);
      edgeSteps.set(edge.id, steps);
    } else {
      ghostHops.push({ source: prev, target: nodeId, step: hop });
    }
  });

  return { nodeOrder, edgeSteps, ghostHops, unmappedSteps };
}
