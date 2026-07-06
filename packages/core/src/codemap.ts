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

export interface CodeModule {
  /** Workspace-relative path of the module root ("." for the workspace root). */
  path: string;
  /** Display name (package.json name or directory name). */
  name: string;
  fileCount: number;
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

export type CodeSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "const"
  | "component"
  | "default"
  | "reexport";

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  /** 1-based line of the declaration. */
  line: number;
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
  /** Workspace-relative paths of files importing this one. */
  importedBy: string[];
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
