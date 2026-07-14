import type { CodeIndex } from "./code-index.js";
import type { CodeSymbolKind, DuplicateCluster } from "./codemap.js";
import type { HoistIntent } from "./refactor.js";

/**
 * Review findings — the deterministic sweep an engineer runs before reading a
 * codebase in anger: exports nobody imports, files nothing references,
 * copy-pasted implementations, relative imports that punch through package
 * boundaries, and utilities other modules keep reaching into.
 *
 * Everything here is derived from the code map (plus the code index for
 * intent tags) and computed pure — same inputs, same findings. Import usage
 * is *barrel-aware*: a symbol imported through `export * from` chains counts
 * as used, and a symbol only re-exported by a module entry file is "public
 * API", demoted to info rather than flagged dead.
 */

export const REVIEW_FINDING_KINDS = [
  "unused-export",
  "dead-file",
  "duplicate",
  "boundary-leak",
  "shared-util",
] as const;
export type ReviewFindingKind = (typeof REVIEW_FINDING_KINDS)[number];

export type ReviewSeverity = "warn" | "info";

export interface ReviewRef {
  file: string;
  symbol?: string | null;
  /** 1-based declaration line (1 for whole-file refs). */
  line: number;
}

export interface ReviewFinding {
  /** Stable across runs while the finding persists. */
  id: string;
  kind: ReviewFindingKind;
  severity: ReviewSeverity;
  /** One line, e.g. `truncate is exported but never imported`. */
  title: string;
  /** The story: modules involved, who imports what. */
  detail: string;
  /** Primary location. */
  ref: ReviewRef;
  module: string;
  /** Other locations (duplicate instances, importing files…). */
  related: ReviewRef[];
  /** Intent tags of the involved files — lets facets/tags filter findings. */
  tags: string[];
  /** Machine-executable suggestion, when one exists (hoist for duplicates). */
  refactor: HoistIntent | null;
}

/** What the sweep needs to know about one file (server supplies these). */
export interface ReviewSourceFile {
  /** Workspace-relative path. */
  path: string;
  /** Code-map module path owning this file. */
  module: string;
  /** True for module entry files (src/index.ts, main.tsx…) — public API. */
  entry: boolean;
  /** True for test files (excluded from most findings). */
  test: boolean;
  symbols: { name: string; kind: CodeSymbolKind; line: number; exported: boolean }[];
  imports: { specifier: string; resolved: string | null; names: string[] }[];
  /** `export … from` statements: name is "*" for star re-exports. */
  reexports: { name: string; specifier: string }[];
}

const REEXPORT_MAX_HOPS = 3;
/** Symbol kinds the unused-export sweep cares about (types are too noisy). */
const VALUE_KINDS: readonly CodeSymbolKind[] = ["function", "const", "class", "component"];

interface UsageIndex {
  /** `file#symbol` imported somewhere (through barrels), by non-plumbing code. */
  usedSymbols: Map<string, Set<string>>;
  /** Files namespace-imported (`* as ns`) — all their exports count as used. */
  nsUsed: Set<string>;
  /** Files referenced by any import/re-export at all (not dead). */
  referenced: Set<string>;
  /** `file#symbol` reachable from a module entry file via re-exports. */
  publicApi: Set<string>;
  /** Modules (other than its own) using each file, via resolved symbols. */
  usingModules: Map<string, Set<string>>;
}

function key(file: string, symbol: string): string {
  return `${file}#${symbol}`;
}

/** The file actually declaring `name`, following re-export chains from `file`. */
function providerOf(
  byPath: Map<string, ReviewSourceFile>,
  file: string,
  name: string,
  hops = 0,
): { file: string; name: string } | null {
  const rec = byPath.get(file);
  if (!rec) return null;
  if (rec.symbols.some((s) => s.name === name)) return { file, name };
  if (hops >= REEXPORT_MAX_HOPS) return null;
  for (const rx of rec.reexports) {
    if (rx.name !== name && rx.name !== "*") continue;
    const imp = rec.imports.find((i) => i.specifier === rx.specifier && i.resolved);
    if (!imp?.resolved) continue;
    const hit = providerOf(byPath, imp.resolved, name, hops + 1);
    if (hit) return hit;
  }
  return null;
}

function buildUsageIndex(files: readonly ReviewSourceFile[]): UsageIndex {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const usedSymbols = new Map<string, Set<string>>();
  const nsUsed = new Set<string>();
  const referenced = new Set<string>();
  const usingModules = new Map<string, Set<string>>();

  const markUse = (target: { file: string; name: string }, from: ReviewSourceFile): void => {
    const k = key(target.file, target.name);
    let set = usedSymbols.get(k);
    if (!set) usedSymbols.set(k, (set = new Set()));
    set.add(from.path);
    const targetModule = byPath.get(target.file)?.module;
    if (targetModule && targetModule !== from.module) {
      let mods = usingModules.get(target.file);
      if (!mods) usingModules.set(target.file, (mods = new Set()));
      mods.add(from.module);
    }
  };

  for (const file of files) {
    const reexported = (name: string, specifier: string): boolean =>
      file.reexports.some((rx) => rx.specifier === specifier && (rx.name === name || rx.name === "*"));
    for (const imp of file.imports) {
      if (!imp.resolved) continue;
      referenced.add(imp.resolved);
      for (const name of imp.names) {
        if (name === "(dynamic)") continue;
        const ns = /^\* as /.test(name);
        if (ns) {
          nsUsed.add(imp.resolved);
          continue;
        }
        if (name === "*") continue; // star re-export: plumbing, references only
        // Re-export plumbing resolves providers but is not a use.
        if (reexported(name, imp.specifier)) continue;
        const target = providerOf(byPath, imp.resolved, name, 0);
        if (target) {
          referenced.add(target.file);
          markUse(target, file);
        }
      }
    }
  }

  // Public API: everything a module entry file exports or re-exports.
  const publicApi = new Set<string>();
  const walkEntry = (file: string, hops: number): void => {
    const rec = byPath.get(file);
    if (!rec) return;
    for (const sym of rec.symbols) {
      if (sym.exported) publicApi.add(key(file, sym.name));
    }
    if (hops >= REEXPORT_MAX_HOPS) return;
    for (const rx of rec.reexports) {
      const imp = rec.imports.find((i) => i.specifier === rx.specifier && i.resolved);
      if (!imp?.resolved) continue;
      if (rx.name === "*") {
        walkEntry(imp.resolved, hops + 1);
      } else {
        const target = providerOf(byPath, imp.resolved, rx.name, 0);
        if (target) publicApi.add(key(target.file, target.name));
      }
    }
  };
  for (const file of files) if (file.entry) walkEntry(file.path, 0);

  return { usedSymbols, nsUsed, referenced, publicApi, usingModules };
}

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

/** Intent tags (`intent:*`) attached to a file or any of its symbols. */
function intentTagsOf(index: CodeIndex | null, path: string): string[] {
  const entry = index?.files.find((f) => f.path === path);
  if (!entry) return [];
  const tags = new Set<string>();
  for (const t of entry.tags) if (t.tag.startsWith("intent:")) tags.add(t.tag);
  for (const s of entry.symbols) {
    for (const t of s.tags) if (t.tag.startsWith("intent:")) tags.add(t.tag);
  }
  return [...tags].sort();
}

function hasUtilTag(index: CodeIndex | null, path: string): boolean {
  const entry = index?.files.find((f) => f.path === path);
  if (!entry) return false;
  const all = [...entry.tags, ...entry.symbols.flatMap((s) => s.tags)];
  return all.some((t) => t.tag === "role:util");
}

/** Deterministic hoist target: the module with the most shared/util files, "shared" names first. */
function guessHoistTarget(files: readonly ReviewSourceFile[], index: CodeIndex | null): string | null {
  const score = new Map<string, number>();
  for (const file of files) {
    if (file.module === ".") continue;
    const sharedName = /(^|\/)(shared|common|core|lib|utils?)$/.test(file.module);
    const util = hasUtilTag(index, file.path);
    if (sharedName || util) {
      score.set(file.module, (score.get(file.module) ?? 0) + (sharedName ? 2 : 1));
    }
  }
  const ranked = [...score.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

const KIND_ORDER: Record<ReviewFindingKind, number> = {
  duplicate: 0,
  "dead-file": 1,
  "unused-export": 2,
  "boundary-leak": 3,
  "shared-util": 4,
};

/**
 * Run the sweep. Pure and deterministic: findings are sorted by severity,
 * kind, then location, and ids are stable while a finding persists.
 */
export function computeReviewFindings(
  files: readonly ReviewSourceFile[],
  duplicates: readonly DuplicateCluster[] = [],
  index: CodeIndex | null = null,
): ReviewFinding[] {
  const usage = buildUsageIndex(files);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings: ReviewFinding[] = [];

  /* ---- dead files ---- */
  const deadFiles = new Set<string>();
  for (const file of files) {
    if (file.entry || file.test || file.symbols.length === 0) continue;
    if (usage.referenced.has(file.path)) continue;
    deadFiles.add(file.path);
    findings.push({
      id: `dead-file:${file.path}`,
      kind: "dead-file",
      severity: "warn",
      title: `${basename(file.path)} is imported by nothing`,
      detail:
        `No file imports ${file.path} — its ${file.symbols.length} top-level ` +
        `symbol${file.symbols.length === 1 ? "" : "s"} (${file.symbols
          .slice(0, 3)
          .map((s) => s.name)
          .join(", ")}${file.symbols.length > 3 ? ", …" : ""}) are unreachable.`,
      ref: { file: file.path, symbol: null, line: 1 },
      module: file.module,
      related: [],
      tags: intentTagsOf(index, file.path),
      refactor: null,
    });
  }

  /* ---- unused exports ---- */
  for (const file of files) {
    if (file.test || deadFiles.has(file.path)) continue;
    if (usage.nsUsed.has(file.path)) continue;
    // Entry files ARE the public surface (and app mains self-execute) —
    // their exports being unimported inside the workspace is expected.
    if (file.entry) continue;
    for (const sym of file.symbols) {
      if (!sym.exported || !VALUE_KINDS.includes(sym.kind)) continue;
      const k = key(file.path, sym.name);
      if (usage.usedSymbols.has(k)) continue;
      const isPublic = usage.publicApi.has(k);
      findings.push({
        id: `unused-export:${k}`,
        kind: "unused-export",
        severity: isPublic ? "info" : "warn",
        title: `${sym.name} is exported but never imported`,
        detail: isPublic
          ? `${sym.name} reaches ${file.module}'s public API through the entry barrel but nothing in this workspace imports it — external consumers may still.`
          : `No file imports ${sym.name} from ${file.path}; the export (or the symbol) can likely go.`,
        ref: { file: file.path, symbol: sym.name, line: sym.line },
        module: file.module,
        related: [],
        tags: intentTagsOf(index, file.path),
        refactor: null,
      });
    }
  }

  /* ---- duplicates ---- */
  const hoistTarget = guessHoistTarget(files, index);
  for (const cluster of duplicates) {
    if (cluster.instances.length < 2) continue;
    const [first, ...rest] = [...cluster.instances].sort(
      (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
    );
    const modules = [...new Set(cluster.instances.map((i) => i.module))].sort();
    const tags = new Set<string>();
    for (const inst of cluster.instances) {
      for (const t of intentTagsOf(index, inst.file)) tags.add(t);
    }
    // A copy split between test and production code is its own disease: the
    // test re-implements the function it should exercise, so the two can
    // drift apart without any test failing.
    const testInstances = cluster.instances.filter((i) => byPath.get(i.file)?.test);
    const prodInstances = cluster.instances.filter((i) => !byPath.get(i.file)?.test);
    const testMirror = testInstances.length > 0 && prodInstances.length > 0;
    findings.push({
      id: `duplicate:${cluster.hash}`,
      kind: "duplicate",
      severity: "warn",
      title: testMirror
        ? `a test re-implements ${prodInstances[0]!.symbol} instead of importing it`
        : `${first!.symbol} is implemented ${cluster.instances.length} times`,
      detail: testMirror
        ? `${testInstances.map((i) => `${i.file}#${i.symbol}`).join(", ")} duplicate${
            testInstances.length === 1 ? "s" : ""
          } ${prodInstances.map((i) => `${i.file}#${i.symbol}`).join(", ")} token-for-token ` +
          `(${cluster.tokenCount} tokens) — the copy can drift from the code it stands in for ` +
          `without any test failing. Import the real implementation instead.`
        : `Identical bodies (${cluster.tokenCount} tokens) in ${modules.join(", ")}: ` +
          cluster.instances.map((i) => `${i.file}#${i.symbol}`).join(" · "),
      ref: { file: first!.file, symbol: first!.symbol, line: first!.line },
      module: first!.module,
      related: rest.map((i) => ({ file: i.file, symbol: i.symbol, line: i.line })),
      tags: [...tags].sort(),
      // Hoisting makes no sense for a test mirror — the fix is importing the
      // production implementation, not extracting a shared copy.
      refactor:
        hoistTarget && !testMirror
          ? {
              id: `refactor_${cluster.hash}`,
              kind: "hoist",
              symbols: cluster.instances.map((i) => ({ file: i.file, symbol: i.symbol })),
              targetModule: hoistTarget,
              targetFile: null,
              newName: null,
            }
          : null,
    });
  }

  /* ---- boundary leaks (relative imports crossing packages) ---- */
  for (const file of files) {
    if (file.test) continue;
    for (const imp of file.imports) {
      if (!imp.resolved || !imp.specifier.startsWith(".")) continue;
      const target = byPath.get(imp.resolved);
      if (!target) continue;
      if (target.module === file.module || target.module === "." || file.module === ".") continue;
      const names = imp.names.filter((n) => n !== "*" && !n.startsWith("* as "));
      findings.push({
        id: `boundary-leak:${file.path}->${imp.resolved}`,
        kind: "boundary-leak",
        severity: "warn",
        title: `${file.module} reaches into ${target.module} with a relative import`,
        detail:
          `${file.path} imports ${names.length > 0 ? names.join(", ") : imp.specifier} ` +
          `via "${imp.specifier}" — a path that bypasses ${target.module}'s public entry point.`,
        ref: { file: file.path, symbol: null, line: 1 },
        module: file.module,
        related: [{ file: imp.resolved, symbol: names[0] ?? null, line: 1 }],
        tags: intentTagsOf(index, file.path),
        refactor: null,
      });
    }
  }

  /* ---- shared utilities living in the wrong package ---- */
  for (const file of files) {
    if (file.test || !hasUtilTag(index, file.path)) continue;
    // Designated shared packages are where utilities belong — skip them.
    if (/(^|\/)(shared|common|core|lib)([/-]|$)/.test(file.module)) continue;
    const users = usage.usingModules.get(file.path);
    if (!users || users.size === 0) continue;
    findings.push({
      id: `shared-util:${file.path}`,
      kind: "shared-util",
      severity: "info",
      title: `${basename(file.path)} is a utility other modules depend on`,
      detail:
        `${[...users].sort().join(", ")} import${users.size === 1 ? "s" : ""} helpers from ` +
        `${file.path} while it lives in ${file.module} — a shared package would make the dependency honest.`,
      ref: { file: file.path, symbol: null, line: 1 },
      module: file.module,
      related: [],
      tags: intentTagsOf(index, file.path),
      refactor: null,
    });
  }

  return findings.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.ref.file.localeCompare(b.ref.file) ||
      (a.ref.symbol ?? "").localeCompare(b.ref.symbol ?? ""),
  );
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
