import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type {
  CodeFileDetail,
  CodeFileSummary,
  CodeImport,
  CodeMapSummary,
  CodeModule,
  CodeModuleDep,
  CodeModuleDetail,
  CodeSymbol,
  CodeSymbolKind,
} from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
const MAX_FILES = 8000;
const MAX_MODULE_FILES_SHOWN = 150;

interface ParsedFile {
  mtimeMs: number;
  loc: number;
  imports: { specifier: string; names: string[] }[];
  exports: CodeSymbol[];
}

interface FileRecord extends ParsedFile {
  /** Workspace-relative path. */
  path: string;
  /** Module path that owns this file. */
  module: string;
  /** Resolved internal import targets (workspace-relative paths). */
  resolvedImports: { specifier: string; resolved: string | null; names: string[] }[];
}

function isCodeFile(name: string): boolean {
  const ext = path.extname(name);
  return CODE_EXTENSIONS.has(ext) && !name.endsWith(".d.ts");
}

/** Package name of a bare specifier ("@scope/pkg/sub" → "@scope/pkg"). */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

/** What one workspace offers to / consumes from other workspaces. */
export interface CrossSurface {
  /** Package name → owning module path within this workspace. */
  packages: Map<string, string>;
  /** External (unresolved, non-relative) imports: fromModule + package + names. */
  externalImports: { fromModule: string; pkg: string; names: string[] }[];
  fileTotal: number;
}

function symbolKindFor(node: ts.Node, name: string, fileName: string): CodeSymbolKind {
  if (ts.isFunctionDeclaration(node)) {
    return /^[A-Z]/.test(name) && /\.[jt]sx$/.test(fileName) ? "component" : "function";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  return "const";
}

/** Parse one source file: imports (static + dynamic + re-exports) and exported symbols. */
export function parseSource(fileRel: string, text: string): Omit<ParsedFile, "mtimeMs"> {
  const scriptKind = fileRel.endsWith(".tsx") || fileRel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileRel, text, ts.ScriptTarget.ES2022, false, scriptKind);
  const imports: ParsedFile["imports"] = [];
  const exports: CodeSymbol[] = [];

  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const isDefault = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  for (const statement of source.statements) {
    // --- imports ---
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const names: string[] = [];
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push(`* as ${clause.namedBindings.name.text}`);
        else for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      imports.push({ specifier: statement.moduleSpecifier.text, names });
      continue;
    }
    // --- re-exports: export { x } from "./y"; export * from "./z" ---
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const names: string[] = [];
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const el of statement.exportClause.elements) {
            names.push(el.name.text);
            exports.push({ name: el.name.text, kind: "reexport", line: lineOf(el) });
          }
        } else {
          names.push("*");
          exports.push({ name: `* from ${statement.moduleSpecifier.text}`, kind: "reexport", line: lineOf(statement) });
        }
        imports.push({ specifier: statement.moduleSpecifier.text, names });
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          exports.push({ name: el.name.text, kind: "const", line: lineOf(el) });
        }
      }
      continue;
    }
    // --- export default ---
    if (ts.isExportAssignment(statement)) {
      exports.push({ name: "default", kind: "default", line: lineOf(statement) });
      continue;
    }
    // --- exported declarations ---
    if (hasExportModifier(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const isComponent =
              /^[A-Z]/.test(name) &&
              decl.initializer != null &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer) ||
                ts.isCallExpression(decl.initializer)) &&
              /\.[jt]sx$/.test(fileRel);
            exports.push({ name, kind: isComponent ? "component" : "const", line: lineOf(decl) });
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        const name = statement.name?.text ?? "default";
        exports.push({
          name,
          kind: isDefault(statement) ? "default" : symbolKindFor(statement, name, fileRel),
          line: lineOf(statement),
        });
      }
    }
  }

  // Dynamic import("...") anywhere in the file.
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, names: ["(dynamic)"] });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return { loc: source.getLineStarts().length, imports, exports };
}

/**
 * Analyzes the workspace into the three-level code map. Results are cached by
 * file mtime; call `analyze()` again after changes — unchanged files are not
 * re-parsed.
 */
export class CodeMapAnalyzer {
  private parseCache = new Map<string, ParsedFile>();
  private records = new Map<string, FileRecord>();
  private importedBy = new Map<string, Set<string>>();
  private modules: CodeModule[] = [];
  private packageNameToModule = new Map<string, string>();
  private analyzing: Promise<void> | null = null;
  private dirty = true;

  constructor(private readonly root: string) {}

  invalidate(): void {
    this.dirty = true;
  }

  private async ensureFresh(): Promise<void> {
    if (!this.dirty && !this.analyzing) return;
    this.analyzing ??= this.analyze().finally(() => {
      this.analyzing = null;
    });
    await this.analyzing;
  }

  /** Full workspace pass (cheap on re-runs thanks to the mtime cache). */
  private async analyze(): Promise<void> {
    this.dirty = false;
    this.packageNameToModule.clear();
    const moduleDirs = await this.discoverModules();
    const files = await this.collectFiles(moduleDirs);

    const records = new Map<string, FileRecord>();
    await Promise.all(
      files.map(async ({ rel, module }) => {
        const abs = resolveInRoot(this.root, rel);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          return;
        }
        let parsed = this.parseCache.get(rel);
        if (!parsed || parsed.mtimeMs !== stat.mtimeMs) {
          try {
            const text = await fs.readFile(abs, "utf8");
            parsed = { mtimeMs: stat.mtimeMs, ...parseSource(rel, text) };
            this.parseCache.set(rel, parsed);
          } catch {
            return;
          }
        }
        records.set(rel, {
          ...parsed,
          path: rel,
          module,
          resolvedImports: [],
        });
      }),
    );

    // Resolve imports now that the full file set is known.
    const fileSet = new Set(records.keys());
    const importedBy = new Map<string, Set<string>>();
    for (const record of records.values()) {
      record.resolvedImports = record.imports.map(({ specifier, names }) => {
        const resolved = this.resolveSpecifier(record.path, specifier, fileSet);
        if (resolved) {
          let set = importedBy.get(resolved);
          if (!set) importedBy.set(resolved, (set = new Set()));
          set.add(record.path);
        }
        return { specifier, resolved, names };
      });
    }

    this.records = records;
    this.importedBy = importedBy;
    this.modules = moduleDirs.map((m) => ({
      ...m,
      fileCount: [...records.values()].filter((r) => r.module === m.path).length,
    }));
  }

  /** package.json dirs (deepest wins for file ownership); "." is always a module. */
  private async discoverModules(): Promise<CodeModule[]> {
    const found: { path: string; name: string }[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
      const abs = resolveInRoot(this.root, rel === "" ? "." : rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      const pkg = entries.find((e) => e.isFile() && e.name === "package.json");
      if (pkg) {
        let name = rel === "" ? path.basename(path.resolve(this.root)) : path.basename(rel);
        try {
          const json = JSON.parse(await fs.readFile(path.join(abs, "package.json"), "utf8"));
          if (typeof json.name === "string" && json.name) {
            name = json.name;
            this.packageNameToModule.set(json.name, rel === "" ? "." : rel);
          }
        } catch {
          /* unparseable package.json — directory name is fine */
        }
        found.push({ path: rel === "" ? "." : rel, name });
      }
      if (depth >= 3) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !isIgnoredDir(entry.name) && !entry.name.startsWith(".")) {
          await walk(rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1);
        }
      }
    };
    await walk("", 0);
    if (!found.some((m) => m.path === ".")) {
      found.unshift({ path: ".", name: path.basename(path.resolve(this.root)) });
    }
    return found.map((m) => ({ ...m, fileCount: 0 }));
  }

  /** All code files, each owned by the deepest module containing it. */
  private async collectFiles(
    modules: CodeModule[],
  ): Promise<{ rel: string; module: string }[]> {
    const modulePaths = [...modules.map((m) => m.path)].sort((a, b) => b.length - a.length);
    const ownerOf = (rel: string): string =>
      modulePaths.find((m) => m !== "." && (rel === m || rel.startsWith(m + "/"))) ?? ".";

    const out: { rel: string; module: string }[] = [];
    const walk = async (rel: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      const abs = resolveInRoot(this.root, rel === "" ? "." : rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!isIgnoredDir(entry.name) && !entry.name.startsWith(".")) await walk(childRel);
        } else if (entry.isFile() && isCodeFile(entry.name)) {
          out.push({ rel: childRel, module: ownerOf(childRel) });
          if (out.length >= MAX_FILES) return;
        }
      }
    };
    await walk("");
    return out;
  }

  private resolveSpecifier(fromRel: string, specifier: string, fileSet: Set<string>): string | null {
    if (specifier.startsWith(".")) {
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromRel), specifier),
      );
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = base + suffix;
        if (fileSet.has(candidate)) return candidate;
        // TS "./x.js" convention for "./x.ts"
        if (suffix === "" && /\.js$/.test(candidate)) {
          const asTs = candidate.replace(/\.js$/, ".ts");
          if (fileSet.has(asTs)) return asTs;
          const asTsx = candidate.replace(/\.js$/, ".tsx");
          if (fileSet.has(asTsx)) return asTsx;
        }
      }
      return null;
    }
    // Workspace package import (optionally with a subpath).
    const parts = specifier.split("/");
    const pkgName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const moduleDir = this.packageNameToModule.get(pkgName);
    if (moduleDir) {
      // Point at the module's entry file when we can find one.
      for (const entry of ["src/index.ts", "src/index.tsx", "index.ts", "src/main.ts"]) {
        const candidate = moduleDir === "." ? entry : `${moduleDir}/${entry}`;
        if (fileSet.has(candidate)) return candidate;
      }
    }
    return null;
  }

  private moduleOf(rel: string): string {
    return this.records.get(rel)?.module ?? ".";
  }

  async summary(): Promise<CodeMapSummary> {
    await this.ensureFresh();
    const weights = new Map<string, number>();
    for (const record of this.records.values()) {
      for (const imp of record.resolvedImports) {
        if (!imp.resolved) continue;
        const target = this.moduleOf(imp.resolved);
        if (target === record.module) continue;
        const key = `${record.module} ${target}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
    const deps: CodeModuleDep[] = [...weights.entries()].map(([key, weight]) => {
      const [source, target] = key.split(" ") as [string, string];
      return { source, target, weight };
    });
    return {
      modules: this.modules,
      deps,
      fileTotal: this.records.size,
      generatedAt: new Date().toISOString(),
    };
  }

  async moduleDetail(modulePath: string): Promise<CodeModuleDetail> {
    await this.ensureFresh();
    const module = this.modules.find((m) => m.path === modulePath);
    if (!module) throw new Error(`Unknown module: ${modulePath}`);

    const records = [...this.records.values()].filter((r) => r.module === modulePath);
    const prefix = modulePath === "." ? "" : modulePath + "/";

    const summaries: CodeFileSummary[] = records.map((r) => {
      const inModule = prefix ? r.path.slice(prefix.length) : r.path;
      return {
        path: r.path,
        name: path.posix.basename(r.path),
        dir: path.posix.dirname(inModule) === "." ? "" : path.posix.dirname(inModule),
        importCount: r.resolvedImports.length,
        exportCount: r.exports.length,
      };
    });

    const edges = [];
    const crossWeights = new Map<string, number>();
    for (const r of records) {
      for (const imp of r.resolvedImports) {
        if (!imp.resolved) continue;
        const targetModule = this.moduleOf(imp.resolved);
        if (targetModule === modulePath) {
          edges.push({ source: r.path, target: imp.resolved });
        } else {
          crossWeights.set(targetModule, (crossWeights.get(targetModule) ?? 0) + 1);
        }
      }
    }
    const moduleDeps: CodeModuleDep[] = [...crossWeights.entries()].map(([target, weight]) => ({
      source: modulePath,
      target,
      weight,
    }));

    // Keep the canvas readable: prefer connected files when truncating.
    let shown = summaries;
    let truncated = false;
    if (summaries.length > MAX_MODULE_FILES_SHOWN) {
      const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
      shown = summaries
        .sort((a, b) => Number(connected.has(b.path)) - Number(connected.has(a.path)))
        .slice(0, MAX_MODULE_FILES_SHOWN);
      truncated = true;
    }
    const shownSet = new Set(shown.map((s) => s.path));

    return {
      module,
      files: shown,
      edges: edges.filter((e) => shownSet.has(e.source) && shownSet.has(e.target)),
      moduleDeps,
      truncated,
    };
  }

  /** Cross-workspace analysis input: published packages + external imports. */
  async crossSurface(): Promise<CrossSurface> {
    await this.ensureFresh();
    const externalImports: CrossSurface["externalImports"] = [];
    for (const record of this.records.values()) {
      for (const imp of record.resolvedImports) {
        if (imp.resolved) continue;
        const pkg = packageNameOf(imp.specifier);
        if (pkg) externalImports.push({ fromModule: record.module, pkg, names: imp.names });
      }
    }
    return {
      packages: new Map(this.packageNameToModule),
      externalImports,
      fileTotal: this.records.size,
    };
  }

  async fileDetail(rel: string): Promise<CodeFileDetail> {
    await this.ensureFresh();
    const record = this.records.get(rel);
    if (!record) throw new Error(`Not an analyzed code file: ${rel}`);
    const imports: CodeImport[] = record.resolvedImports.map((imp) => ({
      specifier: imp.specifier,
      resolved: imp.resolved,
      targetModule: imp.resolved ? this.moduleOf(imp.resolved) : null,
      names: imp.names,
      external: !imp.resolved && !imp.specifier.startsWith("."),
    }));
    return {
      path: rel,
      module: record.module,
      loc: record.loc,
      imports,
      exports: record.exports,
      importedBy: [...(this.importedBy.get(rel) ?? [])].sort(),
    };
  }
}

export { toRelPath };
