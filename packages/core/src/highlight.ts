import type { ArchNode, ArchitectureGraph } from "./architecture.js";
import type { CodeModule } from "./codemap.js";

/**
 * Cross-view highlight — one shared identity for "the thing under the cursor".
 *
 * Every analysis surface (diagram canvas, code map, flamegraph, call profile,
 * journey steps, inspector) renders the same underlying entities at different
 * granularities: an architecture node, a code module, a file, a symbol. A
 * `HighlightRef` names an entity by whichever facets the publishing view
 * knows; consuming views match on whatever facets *they* understand, so a
 * hover on a flamegraph frame (`file#symbol`) lights up the module node on
 * the diagram and the file chip in the code map without either side knowing
 * about the other.
 *
 * Two lifetimes:
 *   hover  — ephemeral, lives in the client highlight store.
 *   pinned — a click, encoded in the deep link (`sel=` param) so it survives
 *            reloads and is shareable like any other view state.
 */
export interface HighlightRef {
  /** Architecture node id (diagram-scoped). */
  node?: string;
  /**
   * Ancestor chain of `node`, root-first (excluding `node` itself). Lets
   * consumers light up the containment hierarchy without holding the graph.
   */
  nodePath?: readonly string[];
  /** Code-map module path, e.g. "packages/core". */
  module?: string;
  /** Workspace-relative file path. */
  file?: string;
  /** Top-level symbol name within `file`. */
  symbol?: string;
  /** Display label for menus and status surfaces. */
  label?: string;
}

/**
 * How a rendered element relates to a highlight ref:
 *   "exact" — same entity at the same granularity (or same diagram node).
 *   "kin"   — same lineage: ancestor or descendant (the symbol's file, the
 *             file's module, a container of the node, …).
 */
export type HighlightMatch = "exact" | "kin" | null;

/** Facet precision: symbol > file > module > node-only. */
function sharpness(ref: HighlightRef): number {
  if (ref.symbol && ref.file) return 3;
  if (ref.file) return 2;
  if (ref.module) return 1;
  if (ref.node) return 0;
  return -1;
}

function isPathWithin(child: string, parent: string): boolean {
  return parent !== "" && parent !== "." && (child === parent || child.startsWith(`${parent}/`));
}

/** True when the two refs name entities on the same file/module lineage. */
function codeKin(a: HighlightRef, b: HighlightRef): boolean {
  if (a.file && b.file && a.file === b.file) return true;
  if (a.module && b.module && (isPathWithin(a.module, b.module) || isPathWithin(b.module, a.module)))
    return true;
  if (a.module && b.file && isPathWithin(b.file, a.module)) return true;
  if (b.module && a.file && isPathWithin(a.file, b.module)) return true;
  return false;
}

/**
 * Match an element's identity against the active highlight. Elements annotate
 * themselves with the same `HighlightRef` shape (plus `nodePath` for the
 * containment chain); the sharpest facet present on both sides decides.
 */
export function matchHighlight(ref: HighlightRef | null | undefined, el: HighlightRef): HighlightMatch {
  if (!ref) return null;
  // Same diagram node is authoritative regardless of code facets.
  if (ref.node && el.node && ref.node === el.node) return "exact";

  const ra = sharpness(ref);
  const rb = sharpness(el);
  if (ra >= 3 && rb >= 3) {
    if (ref.file === el.file && ref.symbol === el.symbol) return "exact";
  } else if (ra === 2 && rb === 2) {
    if (ref.file === el.file) return "exact";
  } else if (ra === 1 && rb === 1) {
    if (ref.module === el.module) return "exact";
  }

  if (codeKin(ref, el)) return "kin";
  // Containment on the diagram: one node sits inside the other.
  if (ref.node && el.nodePath?.includes(ref.node)) return "kin";
  if (el.node && ref.nodePath?.includes(el.node)) return "kin";
  return null;
}

/** True when the ref names anything at all. */
export function hasHighlight(ref: HighlightRef | null | undefined): ref is HighlightRef {
  return !!ref && (!!ref.node || !!ref.module || !!ref.file || !!ref.symbol);
}

/**
 * Serialize the ref's sharpest facet for the `sel=` deep-link param.
 * `sym:<file>#<symbol>` | `file:<path>` | `mod:<path>` | `node:<id>`.
 */
export function formatHighlightSel(ref: HighlightRef): string | null {
  if (ref.symbol && ref.file) return `sym:${ref.file}#${ref.symbol}`;
  if (ref.file) return `file:${ref.file}`;
  if (ref.module) return `mod:${ref.module}`;
  if (ref.node) return `node:${ref.node}`;
  return null;
}

/** Parse a `sel=` param back into a ref. Malformed input yields null. */
export function parseHighlightSel(sel: string | null | undefined): HighlightRef | null {
  if (!sel) return null;
  const idx = sel.indexOf(":");
  if (idx === -1) return null;
  const kind = sel.slice(0, idx);
  const rest = sel.slice(idx + 1);
  if (!rest) return null;
  if (kind === "sym") {
    const hash = rest.lastIndexOf("#");
    if (hash <= 0 || hash === rest.length - 1) return null;
    return { file: rest.slice(0, hash), symbol: rest.slice(hash + 1) };
  }
  if (kind === "file") return { file: rest };
  if (kind === "mod") return { module: rest };
  if (kind === "node") return { node: rest };
  return null;
}

/** Ancestor chain of a node, root-first (excluding the node itself). */
export function ancestorsOf(graph: ArchitectureGraph, nodeId: string): ArchNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chain: ArchNode[] = [];
  let cur = byId.get(nodeId);
  const seen = new Set<string>([nodeId]);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/** The module owning `file`: longest module path that prefixes it. */
export function moduleForFile(file: string, modules: readonly CodeModule[]): string | null {
  let best: string | null = null;
  for (const m of modules) {
    if (m.path === "." || !isPathWithin(file, m.path)) continue;
    if (!best || m.path.length > best.length) best = m.path;
  }
  if (!best && modules.some((m) => m.path === ".")) return ".";
  return best;
}

/**
 * Fill in facets derivable from context: module from file, diagram node (and
 * its ancestor chain) from code links. Pure; never overwrites present facets.
 */
export function enrichHighlight(
  ref: HighlightRef,
  ctx: { graph?: ArchitectureGraph | null; modules?: readonly CodeModule[] | null },
): HighlightRef {
  const out: HighlightRef = { ...ref };
  if (!out.module && out.file && ctx.modules) {
    const m = moduleForFile(out.file, ctx.modules);
    if (m && m !== ".") out.module = m;
  }
  if (ctx.graph) {
    if (!out.node) {
      const byFile = out.file ? ctx.graph.nodes.find((n) => n.codeFile === out.file) : undefined;
      const byModule =
        !byFile && out.module
          ? ctx.graph.nodes.find((n) => n.codeModule === out.module)
          : undefined;
      const hit = byFile ?? byModule;
      if (hit) {
        out.node = hit.id;
        if (!out.label) out.label = hit.label;
      }
    }
    if (out.node && !out.nodePath) {
      const chain = ancestorsOf(ctx.graph, out.node);
      if (chain.length) out.nodePath = chain.map((n) => n.id);
    }
  }
  return out;
}
