import type {
  CodeFileEdge,
  CodeFileSummary,
  CodeMapSummary,
  CodeModuleDetail,
} from "./codemap.js";
import {
  countMarks,
  mergeGhosts,
  type DiffCounts,
  type DiffMarks,
} from "./diagram-diff.js";

/**
 * The codebase ref diff: two `CodeMapSummary` snapshots (head = the working
 * tree, base = the compared ref) merged into one renderable summary plus
 * marks keyed by the code-map scene ids (`m:<module>`, `f:<file>`,
 * `dep:<src>-><tgt>`, `ext:<id>`). Removed modules/files ride along as
 * ghosts so `buildMapScene` lays them out like everything else.
 *
 * Whole-file changes can't be read off a summary (it only carries counts), so
 * the snapshot's status-bearing changed-file list supplies the `f:` marks:
 * added/modified map directly, deleted files become ghosts the scene can
 * render inside their module without needing the base module's detail.
 */

/** One changed file vs the review ref, with its git status. */
export interface ChangedRefFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface CodeMapDiff {
  /** Head summary with base-only modules/deps merged in as ghosts. */
  summary: CodeMapSummary;
  marks: DiffMarks;
  counts: DiffCounts;
}

const moduleOf = (file: string, modulePaths: readonly string[]): string | null => {
  let best: string | null = null;
  for (const path of modulePaths) {
    if (path === "." || file === path || file.startsWith(`${path}/`)) {
      if (best === null || path.length > best.length) best = path;
    }
  }
  return best;
};

export function diffCodeMaps(
  base: CodeMapSummary,
  head: CodeMapSummary,
  opts?: { changedFiles?: readonly ChangedRefFile[] },
): CodeMapDiff {
  const marks: DiffMarks = {};

  const modules = mergeGhosts(
    base.modules,
    head.modules,
    (m) => `m:${m.path}`,
    (before, after) =>
      before.fileCount !== after.fileCount &&
      `${before.fileCount} → ${after.fileCount} files`,
  );
  Object.assign(marks, modules.marks);

  const deps = mergeGhosts(
    base.deps,
    head.deps,
    (d) => `dep:${d.source}->${d.target}`,
    (before, after) =>
      before.weight !== after.weight && `${before.weight} → ${after.weight} imports`,
  );
  Object.assign(marks, deps.marks);

  const externals = mergeGhosts(
    base.externals ?? [],
    head.externals ?? [],
    (e) => `ext:${e.id}`,
  );
  Object.assign(marks, externals.marks);

  // Edited files make their module "changed" even when its file count held
  // steady — the summary alone can't see inside files. Deleted files become
  // ghosts the scene can render inside their module.
  const headModulePaths = head.modules.map((m) => m.path);
  const changedPerModule = new Map<string, number>();
  for (const { path: file, status } of opts?.changedFiles ?? []) {
    const fileKey = `f:${file}`;
    if (!marks[fileKey]) {
      marks[fileKey] =
        status === "added"
          ? { kind: "added" }
          : status === "deleted"
            ? { kind: "removed", ghost: true }
            : { kind: "changed" };
    }
    const mod = moduleOf(file, headModulePaths);
    if (mod !== null) changedPerModule.set(mod, (changedPerModule.get(mod) ?? 0) + 1);
  }
  for (const [mod, count] of changedPerModule) {
    const key = `m:${mod}`;
    const existing = marks[key];
    if (existing?.kind === "added" || existing?.kind === "removed") continue;
    const detail = [
      `${count} file${count === 1 ? "" : "s"} changed`,
      ...(existing?.detail ? [existing.detail] : []),
    ].join(" · ");
    marks[key] = { kind: "changed", detail };
  }

  return {
    summary: {
      ...head,
      modules: modules.items,
      deps: deps.items,
      externals: externals.items.length ? externals.items : head.externals,
    },
    marks,
    counts: countMarks(marks),
  };
}

/**
 * File-level diff inside one drilled module: head files plus base-only ghost
 * files, marks keyed `f:<path>`. Base-only intra-module edges are kept only
 * when they touch a ghost file — a removed import between two surviving
 * files is edge noise the file marks already imply.
 */
export function diffModuleFiles(
  base: CodeModuleDetail | null,
  head: CodeModuleDetail,
  changedFiles?: readonly ChangedRefFile[],
): { files: CodeFileSummary[]; edges: CodeFileEdge[]; marks: DiffMarks } {
  const merged = mergeGhosts(base?.files ?? [], head.files, (f) => `f:${f.path}`);
  const marks = merged.marks;
  for (const { path: file, status } of changedFiles ?? []) {
    const key = `f:${file}`;
    if (status === "modified" && merged.items.some((f) => f.path === file) && !marks[key])
      marks[key] = { kind: "changed" };
  }
  const headEdges = new Set(head.edges.map((e) => `${e.source}->${e.target}`));
  const ghostFiles = new Set(
    merged.items.filter((f) => marks[`f:${f.path}`]?.ghost).map((f) => f.path),
  );
  const edges = [
    ...head.edges,
    ...(base?.edges ?? []).filter(
      (e) =>
        !headEdges.has(`${e.source}->${e.target}`) &&
        (ghostFiles.has(e.source) || ghostFiles.has(e.target)),
    ),
  ];
  return { files: merged.items, edges, marks };
}
