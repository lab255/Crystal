import path from "node:path";
import type {
  CodeArchSnapshot,
  CodeModule,
  CodeModuleDep,
  OverviewSourceFile,
} from "@crystal/core";
import { isCodeFile, isTestFile, parseSource, resolveImportSpecifier } from "./code-map.js";
import { gitCatFiles, gitLsTree, gitResolveRef } from "./git.js";
import { isIgnoredDir, resolveInRoot } from "./paths.js";
import { computeMountPrefixes, joinMountedPath } from "./surfaces-report.js";
import { loadTsPathsConfig, sortTsPathsConfigs, type TsPathsConfig } from "./ts-paths.js";

/**
 * Code-architecture snapshots at a git ref — the same analyses the live code
 * map runs, but over `git ls-tree` / `cat-file` blobs instead of the working
 * tree. Two projections share one tree walk:
 *
 *  - `snapshotAtRef` — module + import-weight graph, feeding
 *    `applyCodeSnapshotToGraph` (diagram ref review);
 *  - `overviewSourcesAtRef` — per-file sources for `buildSystemOverview`,
 *    feeding the systems-level ref diff (`codemap.overviewDiff`).
 */

const MAX_FILES = 8000;
/** package.json this deep still declares a module (matches the live analyzer). */
const MODULE_MAX_DEPTH = 3;

function dirDepth(rel: string): number {
  return rel === "." ? 0 : rel.split("/").length;
}

function underIgnoredDir(rel: string): boolean {
  return rel.split("/").some((seg) => isIgnoredDir(seg) || seg.startsWith("."));
}

interface RefTree {
  commit: string;
  /** Repo-relative path → blob text, code files only (capped). */
  contents: Map<string, string>;
  moduleDirs: { path: string; name: string }[];
  packageNameToModule: Map<string, string>;
  /** tsconfig `paths` aliases at the ref, deepest config first. */
  tsPaths: TsPathsConfig[];
  /** Deepest module owning a repo-relative file. */
  ownerOf: (rel: string) => string;
  /** Repo-relative → workspace-relative (prefixes nested repo roots). */
  rebase: (rel: string) => string;
}

async function loadRefTree(root: string, repoRel: string, ref: string): Promise<RefTree> {
  const cwd = resolveInRoot(root, repoRel || ".");
  const commit = await gitResolveRef(cwd, ref);

  const tree = (await gitLsTree(cwd, ref)).filter((p) => !underIgnoredDir(p));
  const codePaths = tree.filter((p) => isCodeFile(p)).slice(0, MAX_FILES);
  const packagePaths = tree.filter(
    (p) =>
      (p === "package.json" || p.endsWith("/package.json")) &&
      dirDepth(path.posix.dirname(p)) <= MODULE_MAX_DEPTH,
  );

  // Modules: every package.json dir at the ref; "." is always a module.
  const packageJsons = await gitCatFiles(cwd, ref, packagePaths);
  const moduleDirs: { path: string; name: string }[] = [];
  const packageNameToModule = new Map<string, string>();
  for (const pkgPath of packagePaths) {
    const dir = path.posix.dirname(pkgPath);
    const modulePath = dir === "." ? "." : dir;
    let name = modulePath === "." ? path.basename(cwd) : path.posix.basename(modulePath);
    try {
      const json = JSON.parse(packageJsons.get(pkgPath) ?? "");
      if (typeof json.name === "string" && json.name) {
        name = json.name;
        packageNameToModule.set(json.name, modulePath);
      }
    } catch {
      /* unparseable package.json — directory name is fine */
    }
    moduleDirs.push({ path: modulePath, name });
  }
  if (!moduleDirs.some((m) => m.path === ".")) {
    moduleDirs.unshift({ path: ".", name: path.basename(cwd) });
  }

  // Each file is owned by the deepest module containing it.
  const modulePaths = moduleDirs.map((m) => m.path).sort((a, b) => b.length - a.length);
  const ownerOf = (rel: string): string =>
    modulePaths.find((m) => m !== "." && (rel === m || rel.startsWith(m + "/"))) ?? ".";

  // The workspace's paths are workspace-relative; prefix when the repo is a
  // subdirectory of the workspace.
  const prefix =
    !repoRel || repoRel === "." ? "" : repoRel.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const rebase = (p: string): string => (prefix ? (p === "." ? prefix.slice(0, -1) : prefix + p) : p);

  // tsconfig `paths` aliases, read from the same tree so ref snapshots
  // resolve alias imports exactly like the live analyzer.
  const tsconfigPaths = tree.filter(
    (p) =>
      /(^|\/)tsconfig[^/]*\.json$/.test(p) && dirDepth(path.posix.dirname(p)) <= MODULE_MAX_DEPTH,
  );
  const tsconfigTexts = await gitCatFiles(cwd, ref, tsconfigPaths);
  const tsPathsConfigs: TsPathsConfig[] = [];
  for (const configPath of tsconfigPaths) {
    const config = await loadTsPathsConfig((rel) => tsconfigTexts.get(rel) ?? null, configPath);
    if (config) tsPathsConfigs.push(config);
  }
  const tsPaths = sortTsPathsConfigs(tsPathsConfigs);

  const contents = await gitCatFiles(cwd, ref, codePaths);
  return { commit, contents, moduleDirs, packageNameToModule, tsPaths, ownerOf, rebase };
}

export async function snapshotAtRef(
  root: string,
  repoRel: string,
  ref: string,
): Promise<CodeArchSnapshot> {
  const t = await loadRefTree(root, repoRel, ref);
  const fileSet = new Set(t.contents.keys());
  const fileCounts = new Map<string, number>();
  const weights = new Map<string, { source: string; target: string; weight: number }>();

  for (const [rel, text] of t.contents) {
    const module = t.ownerOf(rel);
    fileCounts.set(module, (fileCounts.get(module) ?? 0) + 1);
    let imports: { specifier: string }[];
    try {
      imports = parseSource(rel, text).imports;
    } catch {
      continue;
    }
    for (const { specifier } of imports) {
      const resolved = resolveImportSpecifier(rel, specifier, fileSet, t.packageNameToModule, t.tsPaths);
      if (!resolved) continue;
      const target = t.ownerOf(resolved);
      if (target === module) continue;
      const key = `${module}\0${target}`;
      const entry = weights.get(key) ?? { source: module, target, weight: 0 };
      entry.weight += 1;
      weights.set(key, entry);
    }
  }

  const modules: CodeModule[] = t.moduleDirs.map((m) => ({
    path: t.rebase(m.path),
    name: m.name,
    fileCount: fileCounts.get(m.path) ?? 0,
  }));
  const deps: CodeModuleDep[] = [...weights.values()].map((d) => ({
    source: t.rebase(d.source),
    target: t.rebase(d.target),
    weight: d.weight,
  }));

  return { ref, commit: t.commit, modules, deps, fileTotal: t.contents.size };
}

/**
 * Per-file system-overview inputs at a git ref (workspace-relative paths),
 * for diffing the logical architecture against the working tree.
 */
export async function overviewSourcesAtRef(
  root: string,
  repoRel: string,
  ref: string,
): Promise<{ commit: string; sources: OverviewSourceFile[] }> {
  const t = await loadRefTree(root, repoRel, ref);
  const fileSet = new Set(t.contents.keys());
  const nameOfModule = new Map(t.moduleDirs.map((m) => [m.path, m.name]));

  // Parse everything first so router mounts can resolve across files and
  // endpoint paths compose exactly like the live analyzer's.
  const parsedByRel = new Map<string, ReturnType<typeof parseSource>>();
  for (const [rel, text] of t.contents) {
    try {
      parsedByRel.set(rel, parseSource(rel, text));
    } catch {
      /* unparseable at the ref — skip */
    }
  }
  const resolveImport = (rel: string, specifier: string): string | null =>
    resolveImportSpecifier(rel, specifier, fileSet, t.packageNameToModule, t.tsPaths);
  const prefixes = computeMountPrefixes(
    [...parsedByRel.entries()].map(([rel, parsed]) => ({
      path: rel,
      resolvedMounts: parsed.mounts.flatMap(({ prefix, target }) => {
        const imp = parsed.imports.find(
          (i) => i.names.includes(target) || i.names.includes(`* as ${target}`),
        );
        const resolved = imp ? resolveImport(rel, imp.specifier) : null;
        return resolved ? [{ prefix, resolved }] : [];
      }),
    })),
  );

  const sources: OverviewSourceFile[] = [];
  for (const [rel, parsed] of parsedByRel) {
    const owner = t.ownerOf(rel);
    const prefix = prefixes.get(rel);
    sources.push({
      path: t.rebase(rel),
      pkg: t.rebase(owner),
      pkgName: nameOfModule.get(owner),
      test: isTestFile(rel),
      imports: parsed.imports.map(({ specifier, names }) => {
        const resolved = resolveImport(rel, specifier);
        return { specifier, resolved: resolved ? t.rebase(resolved) : null, names };
      }),
      exports: parsed.exports.map(({ name, kind, signature }) => ({ name, kind, signature })),
      endpoints: prefix
        ? parsed.endpoints.map((ep) => ({ ...ep, path: joinMountedPath(prefix, ep.path) }))
        : parsed.endpoints,
      apiCalls: parsed.apiCalls,
    });
  }
  return { commit: t.commit, sources };
}
