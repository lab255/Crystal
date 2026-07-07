import {
  archKindForCodeModule,
  createArchNode,
  significantModules,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
  type CodeMapSummary,
  uid,
} from "@crystal/core";
import { autoLayout, fitContainersToChildren } from "./layout.js";

/**
 * Seed a starting diagram from the code map: one node per module (linked via
 * `codeModule`, so the live overlay and dataflow projection work immediately),
 * grouped by top-level directory, with import edges from the module graph.
 * The user edits from there — the seed is a starting point, not a sync.
 */

/** Top-level dirs holding at least this many modules become group containers. */
const GROUP_MIN_MODULES = 2;

function topDirOf(modulePath: string): string | null {
  return modulePath.includes("/") ? (modulePath.split("/")[0] ?? null) : null;
}

export function seedFromCodeMap(
  base: ArchitectureGraph,
  summary: CodeMapSummary,
): ArchitectureGraph {
  const modules = significantModules(summary.modules);

  // Top-level dirs with enough modules become containers ("apps", "packages"…).
  const dirCounts = new Map<string, number>();
  for (const m of modules) {
    const dir = topDirOf(m.path);
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const groupDirs = [...dirCounts.entries()]
    .filter(([, count]) => count >= GROUP_MIN_MODULES)
    .map(([dir]) => dir)
    .sort();

  // Parents must precede children in the node array (react-flow convention).
  const nodes: ArchNode[] = [];
  const groupIdByDir = new Map<string, string>();
  for (const dir of groupDirs) {
    const group = createArchNode("group", `${dir}/`, { x: 0, y: 0 });
    groupIdByDir.set(dir, group.id);
    nodes.push(group);
  }

  const nodeIdByModule = new Map<string, string>();
  for (const m of modules) {
    const dir = topDirOf(m.path);
    const parentId = dir ? (groupIdByDir.get(dir) ?? null) : null;
    const node = createArchNode(archKindForCodeModule(m), m.name, { x: 0, y: 0 }, parentId);
    nodes.push({
      ...node,
      description: `${m.fileCount} ${m.fileCount === 1 ? "file" : "files"}`,
      codeModule: m.path,
    });
    nodeIdByModule.set(m.path, node.id);
  }

  const edges: ArchEdge[] = [];
  for (const dep of summary.deps) {
    const source = nodeIdByModule.get(dep.source);
    const target = nodeIdByModule.get(dep.target);
    if (!source || !target || source === target) continue;
    edges.push({ id: uid("edge"), source, target, kind: "dependency", label: `×${dep.weight}` });
  }

  // Two layout passes: the first places children inside their containers,
  // sizing fits each container to its children, and the second re-flows the
  // root scope with the real container sizes.
  let graph: ArchitectureGraph = { ...base, nodes, edges };
  graph = fitContainersToChildren(autoLayout(graph));
  graph = fitContainersToChildren(autoLayout(graph));
  return graph;
}

/** True when the workspace has enough analyzed structure to seed from. */
export function canSeedFromCodeMap(summary: CodeMapSummary | null): summary is CodeMapSummary {
  if (!summary) return false;
  return summary.modules.filter((m) => m.fileCount > 0).length >= 2;
}
