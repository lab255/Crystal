import {
  createArchNode,
  isContainerKind,
  type ArchEdge,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "./architecture.js";
import type { CodeModule, CodeModuleDep } from "./codemap.js";
import { uid } from "./ids.js";

/**
 * Architecture review — project a code-architecture snapshot (the module +
 * import graph at some git ref, computed by the server from `git ls-tree` /
 * `cat-file`) onto an existing diagram. The result is what the diagram would
 * look like if the code at that ref were the truth: modules that exist there
 * but not on the diagram appear, module nodes whose code is gone disappear,
 * and code-derived dependency edges are rebuilt. Hand-drawn content (nodes
 * without a `codeModule` link, sync/async/data edges, notes, groups) is never
 * touched — the projection reviews the code's architecture, not the user's
 * annotations.
 *
 * Wrapped in an `ArchDraft` (base = current graph, graph = projection), this
 * turns "review this PR / commit architecturally" into the existing draft
 * workflow: diff at a glance, rebase, discard.
 */

/** A code-architecture snapshot (modules + import edges) at one git ref. */
export interface CodeArchSnapshot {
  /** The ref as requested (branch, tag, or hash). */
  ref: string;
  /** Resolved short commit hash. */
  commit: string;
  modules: CodeModule[];
  deps: CodeModuleDep[];
  fileTotal: number;
}

/** Diagram node kind for a code module (shared by seeding and ref review). */
export function archKindForCodeModule(module: CodeModule): ArchNodeKind {
  const underApps = module.path === "apps" || module.path.startsWith("apps/");
  if (underApps) {
    return /web|ui|front|desktop/i.test(`${module.name} ${module.path}`)
      ? "frontend"
      : "service";
  }
  return "repo";
}

function topDirOf(modulePath: string): string | null {
  return modulePath.includes("/") ? (modulePath.split("/")[0] ?? null) : null;
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** True when a description is the seeded "N files" counter (safe to refresh). */
function isFileCountDescription(description: string): boolean {
  return description === "" || /^\d+ files?$/.test(description);
}

/** Modules worth a node: non-empty, and not the root when submodules exist. */
export function significantModules(modules: CodeModule[]): CodeModule[] {
  const hasSubmodules = modules.some((m) => m.path !== "." && m.fileCount > 0);
  return modules.filter((m) => m.fileCount > 0 && !(m.path === "." && hasSubmodules));
}

/**
 * Rewrite `graph` to reflect `snapshot`'s code architecture. Pure — returns a
 * new graph; ids of surviving nodes are preserved so diffs and drafts line up.
 */
export function applyCodeSnapshotToGraph(
  graph: ArchitectureGraph,
  snapshot: Pick<CodeArchSnapshot, "modules" | "deps">,
): ArchitectureGraph {
  const modules = significantModules(snapshot.modules);
  const modulePaths = new Set(modules.map((m) => m.path));

  // Module-linked leaf nodes are the code-derived surface this projection owns.
  const nodeByModule = new Map<string, ArchNode>();
  for (const n of graph.nodes) {
    if (n.codeModule && !isContainerKind(n.kind)) nodeByModule.set(n.codeModule, n);
  }

  // Drop module nodes whose code does not exist at the ref.
  const removedIds = new Set<string>();
  for (const [modulePath, node] of nodeByModule) {
    if (!modulePaths.has(modulePath)) {
      removedIds.add(node.id);
      nodeByModule.delete(modulePath);
    }
  }

  let nodes = graph.nodes
    .filter((n) => !removedIds.has(n.id))
    .map((n) => {
      // Refresh the seeded file counter; leave hand-written descriptions alone.
      const module = n.codeModule ? modules.find((m) => m.path === n.codeModule) : undefined;
      if (!module || !isFileCountDescription(n.description)) return n;
      const description = fileCountLabel(module.fileCount);
      return description === n.description ? n : { ...n, description };
    });

  // Add nodes for modules that exist at the ref but not on the diagram, slotted
  // into the matching "<dir>/" group (the seed convention) when there is one.
  const groupIdByLabel = new Map(
    nodes.filter((n) => isContainerKind(n.kind)).map((n) => [n.label, n.id]),
  );
  const newModules = modules.filter((m) => !nodeByModule.has(m.path));
  for (const m of newModules) {
    const dir = topDirOf(m.path);
    const parentId = dir ? (groupIdByLabel.get(`${dir}/`) ?? null) : null;
    const siblings = nodes.filter((n) => (n.parentId ?? null) === parentId && !isContainerKind(n.kind));
    const position = {
      x: 24,
      y: siblings.reduce((max, s) => Math.max(max, s.position.y), 0) + 120,
    };
    const node: ArchNode = {
      ...createArchNode(archKindForCodeModule(m), m.name, position, parentId),
      description: fileCountLabel(m.fileCount),
      codeModule: m.path,
    };
    nodes = [...nodes, node];
    nodeByModule.set(m.path, node);
  }

  // Rebuild code-derived dependency edges. Managed = `dependency` edges whose
  // endpoints are both module-linked; everything else is the user's.
  const moduleNodeIds = new Set([...nodeByModule.values()].map((n) => n.id));
  const desired = new Map<string, { source: string; target: string; weight: number }>();
  for (const dep of snapshot.deps) {
    const source = nodeByModule.get(dep.source);
    const target = nodeByModule.get(dep.target);
    if (!source || !target || source.id === target.id) continue;
    desired.set(`${source.id}->${target.id}`, {
      source: source.id,
      target: target.id,
      weight: dep.weight,
    });
  }

  const edges: ArchEdge[] = [];
  for (const e of graph.edges) {
    if (removedIds.has(e.source) || removedIds.has(e.target)) continue;
    const managed =
      e.kind === "dependency" && moduleNodeIds.has(e.source) && moduleNodeIds.has(e.target);
    if (!managed) {
      edges.push(e);
      continue;
    }
    const want = desired.get(`${e.source}->${e.target}`);
    if (!want) continue; // import relationship gone at the ref
    desired.delete(`${e.source}->${e.target}`);
    const label = `×${want.weight}`;
    edges.push(label === e.label ? e : { ...e, label });
  }
  for (const want of desired.values()) {
    edges.push({
      id: uid("edge"),
      source: want.source,
      target: want.target,
      kind: "dependency",
      label: `×${want.weight}`,
    });
  }

  return { ...graph, nodes, edges };
}
