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

import type { CodeExternalDep, CodeLibraryDep } from "./external-services.js";

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
  /**
   * Heaviest plain npm libraries (not services) with their importing modules
   * — what the code leans on. Optional like `externals`.
   */
  libraries?: CodeLibraryDep[];
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
  /**
   * Compact declaration signature for function-like symbols —
   * `"(a: string, b?: number): Promise<Foo>"`. Whitespace-collapsed and
   * length-capped by the analyzer; absent for non-callables.
   */
  signature?: string;
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
  /** Local alias of the default binding (`import X from …` → "X"), if any. */
  defaultName?: string;
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

/** One place a symbol is used — an import statement or a call site. */
export interface SymbolSite {
  /** Workspace-relative file containing the site. */
  file: string;
  /** 1-based line, when the analyzer captured one. */
  line: number | null;
  /** The site's source line, trimmed and length-capped. */
  text?: string;
  /** Enclosing top-level symbol — the caller, for call sites. */
  symbol?: string;
}

/**
 * Where a symbol is declared and everywhere consumers pick it up: the import
 * statements bringing it across (barrel re-exports followed) and the call
 * sites invoking it, per the syntax call graph.
 */
export interface CodeSymbolSites {
  file: string;
  symbol: string;
  /** Declaration range in `file` — the export site. */
  declaration: { line: number; endLine: number };
  imports: SymbolSite[];
  calls: SymbolSite[];
  /** True when either list hit the server's cap. */
  truncated: boolean;
}

/** One import statement crossing a part boundary — a concrete integration point. */
export interface PartCrossing {
  /** Importing file (inside the source part). */
  file: string;
  /** 1-based line of the import statement, when the analyzer captured one. */
  line: number | null;
  /** Imported names ("default" / "*" included). */
  names: string[];
  /** Imported file (inside the target part). */
  targetFile: string;
  /** The import statement's source line, trimmed and length-capped. */
  text?: string;
}

/**
 * Where one part-pair of a system boundary actually connects: every import
 * statement from files owned by the source part into files owned by the
 * target part. Ownership is longest-prefix over the provided part lists, the
 * same attribution the overview's `SystemLink.parts` uses.
 */
export interface PartCrossings {
  sourcePart: string;
  targetPart: string;
  crossings: PartCrossing[];
  /** True when the list hit the server's cap. */
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
  /**
   * A reference edge: the callee is invoked reflectively — a framework
   * handler (`app.get("/x", handler)`), a callback argument, a handler-table
   * entry — rather than called directly.
   */
  dynamic?: boolean;
}

/**
 * A call-graph trace from one entry symbol. Syntax-resolved only: handler
 * and callback *references* resolve as `dynamic` edges; instance method
 * calls the syntax can't attribute land in `unresolvedCalls` rather than
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

/** One outgoing HTTP call reached on the call-graph walk from an entry symbol. */
export interface ApiTraceCall {
  method: string;
  /** The call path as parsed — unresolved template holes appear as "*". */
  path: string;
  /** Call site. */
  file: string;
  line?: number;
  /**
   * Symbol whose body issues the call, with its BFS depth from the entry
   * (entry = 0). Absent for module-scope calls in the entry file.
   */
  via?: { file: string; symbol: string; depth: number };
  /** Best-matching served route registration, when one resolves. */
  endpoint?: { method: string; path: string; file: string; line?: number; handler?: string };
}

/**
 * The frontend→backend chain from one component/hook: every HTTP call its
 * (syntactic) call graph can reach, each matched to the endpoint serving it.
 */
export interface ApiTrace {
  entry: { file: string; symbol?: string };
  calls: ApiTraceCall[];
  /** Call-graph depth/node caps hit — deeper calls may exist. */
  truncated: boolean;
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
/* Working-set changes (no VCS required)                               */
/* ------------------------------------------------------------------ */

/**
 * The recent working set, derived from file timestamps rather than a VCS —
 * the only "what changed?" signal available in workspaces without git (or
 * with everything committed). Timestamps make it a review aid, not a diff:
 * it says which files moved and how they are wired, not what lines changed.
 */

/** One recently touched code file. */
export interface ChangedFileEntry {
  path: string;
  module: string;
  /**
   * "added" when the file was created inside the window (birthtime);
   * "modified" otherwise. Filesystems without creation times degrade to
   * "modified".
   */
  status: "added" | "modified";
  /** Last modification, ISO. */
  mtime: string;
  test: boolean;
  loc: number;
  /** Exported symbols (capped) — the file's public surface at a glance. */
  exports: { name: string; kind: CodeSymbolKind }[];
  /** How many files import this one right now. */
  importedBy: number;
  /** Direct importers outside the changed set (capped) — the blast radius. */
  dependents: string[];
}

/** Per-module rollup of the working set. */
export interface ChangedModuleSummary {
  module: string;
  added: number;
  modified: number;
  /** True when a test file in the module was touched inside the window. */
  testsTouched: boolean;
}

export interface WorkingSetReport {
  /** Window the report covers, hours before `generatedAt`. */
  sinceHours: number;
  /** Window start, ISO. */
  since: string;
  /** Touched files, newest first (capped — `total` counts them all). */
  files: ChangedFileEntry[];
  total: number;
  modules: ChangedModuleSummary[];
  /** Added source files nothing imports yet and no entry convention claims. */
  unwired: string[];
  generatedAt: string;
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
