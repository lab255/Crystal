import path from "node:path";
import type { CodeArchSnapshot, CodeModule, CodeModuleDep } from "@crystal/core";
import { isCodeFile, parseSource, resolveImportSpecifier } from "./code-map.js";
import { gitCatFiles, gitLsTree, gitResolveRef } from "./git.js";
import { isIgnoredDir, resolveInRoot } from "./paths.js";

/**
 * Code-architecture snapshot at a git ref — the same module + import-weight
 * analysis the live code map runs, but over `git ls-tree` / `cat-file` blobs
 * instead of the working tree. Feeds `applyCodeSnapshotToGraph` (core) so a
 * PR head or an old commit can be reviewed against the current diagram.
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

export async function snapshotAtRef(
  root: string,
  repoRel: string,
  ref: string,
): Promise<CodeArchSnapshot> {
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

  const contents = await gitCatFiles(cwd, ref, codePaths);
  const fileSet = new Set(contents.keys());
  const fileCounts = new Map<string, number>();
  const weights = new Map<string, { source: string; target: string; weight: number }>();

  for (const [rel, text] of contents) {
    const module = ownerOf(rel);
    fileCounts.set(module, (fileCounts.get(module) ?? 0) + 1);
    let imports: { specifier: string }[];
    try {
      imports = parseSource(rel, text).imports;
    } catch {
      continue;
    }
    for (const { specifier } of imports) {
      const resolved = resolveImportSpecifier(rel, specifier, fileSet, packageNameToModule);
      if (!resolved) continue;
      const target = ownerOf(resolved);
      if (target === module) continue;
      const key = `${module}\0${target}`;
      const entry = weights.get(key) ?? { source: module, target, weight: 0 };
      entry.weight += 1;
      weights.set(key, entry);
    }
  }

  // The graph's `codeModule` links are workspace-relative; prefix when the
  // repo is a subdirectory of the workspace.
  const prefix = !repoRel || repoRel === "." ? "" : repoRel.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const rebase = (p: string): string => (prefix ? (p === "." ? prefix.slice(0, -1) : prefix + p) : p);

  const modules: CodeModule[] = moduleDirs.map((m) => ({
    path: rebase(m.path),
    name: m.name,
    fileCount: fileCounts.get(m.path) ?? 0,
  }));
  const deps: CodeModuleDep[] = [...weights.values()].map((d) => ({
    source: rebase(d.source),
    target: rebase(d.target),
    weight: d.weight,
  }));

  return { ref, commit, modules, deps, fileTotal: contents.size };
}
