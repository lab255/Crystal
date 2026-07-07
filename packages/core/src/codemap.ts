/**
 * Code map — architecture derived from the codebase itself, at three levels
 * of detail:
 *
 *   workspace  → modules (packages/apps) and their aggregated import edges
 *   module     → files and file-to-file imports inside one module
 *   file       → the file's symbols (exports) and its import neighborhood
 *
 * The map is computed by the bridge server from source (TypeScript parser),
 * cached by mtime, and re-broadcast (`codemap.changed`) whenever watched code
 * changes — the diagram follows the code, not the other way around.
 */

import type { CodeExternalDep } from "./external-services.js";

/**
 * The global level-of-detail ladder for the code map: how much of the
 * repositories → packages → modules (files) → members (symbols) hierarchy is
 * exposed at once. Deep-linkable (see deeplink.ts); ordered coarse → fine.
 */
export const CODE_LOD_LEVELS = ["repos", "packages", "modules", "members"] as const;
export type CodeLodLevel = (typeof CODE_LOD_LEVELS)[number];

/** Positions in the ladder, for slider math and comparisons. */
export function lodIndex(level: CodeLodLevel): number {
  return CODE_LOD_LEVELS.indexOf(level);
}

export interface CodeModule {
  /** Workspace-relative path of the module root ("." for the workspace root). */
  path: string;
  /** Display name (package.json name or directory name). */
  name: string;
  fileCount: number;
  /**
   * True when this module is versioned independently of the workspace — it
   * has its own `.git` (a nested/sub repository). Workspace packages that
   * ride the host repo's history are packages, not repositories; this flag
   * is what distinguishes them. Optional so cached summaries stay valid.
   */
  versioned?: boolean;
}

export interface CodeModuleDep {
  /** Module path. */
  source: string;
  /** Module path. */
  target: string;
  /** Number of file-level imports crossing this boundary. */
  weight: number;
}

export interface CodeMapSummary {
  modules: CodeModule[];
  deps: CodeModuleDep[];
  /**
   * External services detected from the codebase's npm imports (databases,
   * caches, queues, SaaS APIs…) — see `external-services.ts`. Optional so
   * older/partial summaries stay valid; absent means "not analyzed".
   */
  externals?: CodeExternalDep[];
  fileTotal: number;
  generatedAt: string;
}

export interface CodeFileSummary {
  /** Workspace-relative path. */
  path: string;
  name: string;
  /** Directory relative to the module root ("" at module root). */
  dir: string;
  importCount: number;
  exportCount: number;
}

export interface CodeFileEdge {
  source: string;
  target: string;
}

export interface CodeModuleDetail {
  module: CodeModule;
  files: CodeFileSummary[];
  /** Imports between files of this module. */
  edges: CodeFileEdge[];
  /** Aggregated imports from this module's files into other modules. */
  moduleDeps: CodeModuleDep[];
  /** True when `files` was truncated for display. */
  truncated: boolean;
}

export const CODE_SYMBOL_KINDS = [
  "function",
  "class",
  "interface",
  "enum",
  "type",
  "const",
  "component",
  "default",
  "reexport",
] as const;

export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number];

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  /** 1-based inclusive last line of the declaration. */
  endLine?: number;
  exported?: boolean;
}

export interface CodeImport {
  /** Import specifier as written. */
  specifier: string;
  /** Workspace-relative resolved file, when internal. */
  resolved: string | null;
  /** Module path of the resolved target, when internal. */
  targetModule: string | null;
  /** Imported names ("default" / "*" included). */
  names: string[];
  external: boolean;
}

export interface CodeFileDetail {
  path: string;
  module: string;
  loc: number;
  imports: CodeImport[];
  exports: CodeSymbol[];
  /** Every top-level symbol (exported and internal), with source ranges. */
  symbols: CodeSymbol[];
  /** Workspace-relative paths of files importing this one. */
  importedBy: string[];
}

/* ------------------------------------------------------------------ */
/* Symbol-level queries: source, call traces, duplicates, search       */
/* ------------------------------------------------------------------ */

/** A top-level symbol addressed by file + name. */
export interface CodeSymbolRef {
  /** Workspace-relative file path. */
  file: string;
  symbol: string;
}

export interface CodeSymbolSource {
  file: string;
  symbol: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface CodeTraceStep {
  ref: CodeSymbolRef;
  /** Module path owning the file. */
  module: string;
  /** Declaration line of the symbol. */
  line: number;
  /** BFS depth from the entry (entry = 0). */
  depth: number;
}

export interface CodeTraceEdge {
  from: CodeSymbolRef;
  to: CodeSymbolRef;
}

/**
 * A call-graph trace from one entry symbol. Syntax-resolved only: instance
 * method calls and dynamic dispatch land in `unresolvedCalls` rather than
 * silently vanishing.
 */
export interface CodeTrace {
  entry: CodeSymbolRef;
  /** BFS order, entry first. */
  steps: CodeTraceStep[];
  edges: CodeTraceEdge[];
  /** Depth or node cap hit. */
  truncated: boolean;
  unresolvedCalls: { from: CodeSymbolRef; callee: string }[];
}

/**
 * A ranked journey suggestion: a code entry point whose call graph fans out
 * across many modules — a good candidate "top user journey" to trace on the
 * diagram. Derived live from the call graph; never persisted.
 */
export interface JourneySuggestion {
  entry: CodeSymbolRef;
  kind: CodeSymbolKind;
  /** Module path owning the entry file. */
  entryModule: string;
  /** Distinct modules the bounded trace touches (entry module included). */
  moduleSpan: number;
  /** Symbols reached by the bounded trace (entry included). */
  stepCount: number;
}

export interface DuplicateInstance {
  file: string;
  module: string;
  symbol: string;
  line: number;
  endLine: number;
  exported: boolean;
}

/** Functions whose normalized token streams hash identically. */
export interface DuplicateCluster {
  hash: string;
  tokenCount: number;
  instances: DuplicateInstance[];
}

export interface SymbolSearchHit {
  file: string;
  module: string;
  name: string;
  kind: CodeSymbolKind;
  line: number;
  exported: boolean;
}

/* ------------------------------------------------------------------ */
/* Cross-workspace imports                                             */
/* ------------------------------------------------------------------ */

/**
 * When several workspaces are open, an import in workspace A whose package
 * name is published by workspace B is a cross-workspace edge: A imports what
 * B exports. The map below aggregates those per workspace pair.
 */

/** One consuming module's use of a cross-workspace package. */
export interface CrossImportUse {
  /** Module path in the importing workspace. */
  fromModule: string;
  /** Number of import statements. */
  count: number;
  /** Imported names, deduplicated ("default" / "* as x" included). */
  names: string[];
}

/** All uses of one exported package along a workspace-pair edge. */
export interface CrossPackageUse {
  /** Package name as imported (e.g. "@crystal/core"). */
  pkg: string;
  /** Module path in the exporting workspace that owns the package. */
  toModule: string;
  count: number;
  uses: CrossImportUse[];
}

export interface CrossWorkspaceEdge {
  /** Importing workspace id. */
  source: string;
  /** Exporting workspace id. */
  target: string;
  /** Total import statements crossing this pair. */
  weight: number;
  packages: CrossPackageUse[];
}

export interface CrossWorkspaceNode {
  /** Workspace id. */
  id: string;
  name: string;
  root: string;
  fileTotal: number;
  /** Package names this workspace publishes (importable surface). */
  packages: string[];
}

export interface CrossWorkspaceMap {
  workspaces: CrossWorkspaceNode[];
  edges: CrossWorkspaceEdge[];
  generatedAt: string;
}
