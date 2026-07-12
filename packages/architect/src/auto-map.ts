import {
  applyCodeSnapshotToGraph,
  diffGraphs,
  isContainerKind,
  type ArchDiff,
  type ArchitectureGraph,
  type CodeMapSummary,
} from "@crystal/core";
import { canSeedFromCodeMap } from "./seed.js";

/**
 * Auto architecture mapping — keeping a code-mapped diagram honest against
 * the live code map. Two halves, both driven by the same projection:
 *
 *  - the *auto-mapper* seeds an empty diagram from the code map the moment
 *    analyzable code exists (ArchitectMode does the seeding via
 *    `seedFromCodeMap`; the trigger lives there);
 *  - the *drift detector* below re-projects the live module + import graph
 *    onto the saved diagram (`applyCodeSnapshotToGraph`) and diffs the two.
 *    Structural differences — modules or import relationships that appeared
 *    or disappeared — surface as drift the user can sync or review.
 *
 * Only diagrams with module-linked nodes participate: a hand-drawn diagram
 * has no code-derived surface to drift from, and projecting the whole
 * codebase onto it would spam it with every module. Label-only changes
 * (import weights, file counters) never count as drift on their own — they
 * ride along when a sync or review applies the projection.
 */

/** How many change lines `ArchDrift.items` carries before truncating. */
const DRIFT_ITEM_CAP = 6;

/** True when the diagram tracks code: at least one module-linked leaf node. */
export function isCodeMapped(graph: ArchitectureGraph): boolean {
  return graph.nodes.some((n) => n.codeModule && !isContainerKind(n.kind));
}

export interface ArchDrift {
  /** The diagram as the live code map says it should look. */
  projected: ArchitectureGraph;
  /** Full semantic diff of saved graph → projection. */
  diff: ArchDiff;
  /** Structural changes only: nodes/edges added or removed. */
  total: number;
  /** Human-readable change lines (capped; ends with "+N more" when truncated). */
  items: string[];
}

/**
 * Detect structural drift between a saved diagram and the live code map.
 * Returns null when there is nothing to say: the summary is too thin to
 * trust, the diagram is not code-mapped, or the projection changes nothing
 * structural. Pure — same inputs, same answer.
 */
export function detectDrift(
  graph: ArchitectureGraph,
  summary: CodeMapSummary | null,
): ArchDrift | null {
  if (!canSeedFromCodeMap(summary) || !isCodeMapped(graph)) return null;

  const projected = applyCodeSnapshotToGraph(graph, summary);
  const diff = diffGraphs(graph, projected);
  const total =
    diff.addedNodes.length +
    diff.removedNodes.length +
    diff.addedEdges.length +
    diff.removedEdges.length;
  if (total === 0) return null;

  // Labels for edge endpoints can live on either side of the diff.
  const labelOf = new Map<string, string>();
  for (const n of [...graph.nodes, ...projected.nodes]) labelOf.set(n.id, n.label);
  const arrow = (source: string, target: string): string =>
    `${labelOf.get(source) ?? source} → ${labelOf.get(target) ?? target}`;

  const items: string[] = [
    ...diff.addedNodes.map((n) => `new: ${n.label}`),
    ...diff.removedNodes.map((n) => `removed: ${n.label}`),
    ...diff.addedEdges.map((e) => `new dependency: ${arrow(e.source, e.target)}`),
    ...diff.removedEdges.map((e) => `dropped dependency: ${arrow(e.source, e.target)}`),
  ];
  if (items.length > DRIFT_ITEM_CAP) {
    items.splice(DRIFT_ITEM_CAP, items.length, `+${items.length - DRIFT_ITEM_CAP} more`);
  }

  return { projected, diff, total, items };
}

/**
 * Identity of one drift state, for "dismiss until something new happens":
 * the same diagram with the same outstanding changes keeps the same
 * signature; any code movement mints a new one and re-surfaces the banner.
 */
export function driftSignature(archPath: string, drift: ArchDrift): string {
  return `${archPath}::${drift.total}::${drift.items.join("|")}`;
}
