import path from "node:path";
import ts from "typescript";

/**
 * tsconfig `paths` alias support for the code map's import resolution.
 *
 * A workspace can hold several tsconfigs (one per package plus shared bases
 * reached via `extends`). Each config with an effective `paths` compiles into
 * one `TsPathsConfig`; resolution picks the deepest config whose directory
 * contains the importing file — the config that would actually govern that
 * file's compilation.
 *
 * Loading is accessor-based (workspace-relative path → file text) so the live
 * analyzer (disk) and ref snapshots (git blobs) resolve identically.
 */

export interface TsPathPattern {
  /** Literal part before the `*` (the whole pattern when `exact`). */
  prefix: string;
  /** Literal part after the `*` (empty when `exact`). */
  suffix: string;
  /** Pattern has no `*` — the specifier must match `prefix` verbatim. */
  exact: boolean;
  /** Workspace-relative target templates, `*` standing for the matched span. */
  targets: string[];
}

export interface TsPathsConfig {
  /** Workspace-relative directory of the tsconfig ("." for the root). */
  dir: string;
  /** Longest-prefix-first, mirroring TypeScript's pattern selection. */
  patterns: TsPathPattern[];
}

export type ReadTextFile = (rel: string) => string | null | Promise<string | null>;

/** Follow `extends` chains at most this far (guards against cycles). */
const EXTENDS_MAX_HOPS = 5;

interface EffectiveOptions {
  /** `baseUrl` plus the config dir that declared it (relative paths resolve there). */
  baseUrl?: { value: string; dir: string };
  /** `paths` plus the config dir that declared it. */
  paths?: { value: Record<string, string[]>; dir: string };
}

function normalizeRel(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, "/"));
  return norm === "." ? "." : norm.replace(/^\.\//, "");
}

/**
 * Read one tsconfig (JSONC-tolerant) and merge its `extends` chain the way
 * TypeScript does: children override parents key-by-key, `paths` replaced as a
 * whole, relative values anchored to the file that declared them. Bare
 * `extends` (package refs like "@tsconfig/node20") are skipped — their
 * configs live in node_modules and never carry project-local aliases.
 */
async function loadEffectiveOptions(
  read: ReadTextFile,
  configRel: string,
  hops: number,
  seen: Set<string>,
): Promise<EffectiveOptions | null> {
  const rel = normalizeRel(configRel);
  if (hops > EXTENDS_MAX_HOPS || seen.has(rel)) return null;
  seen.add(rel);

  const text = await read(rel);
  if (text == null) return null;
  const { config } = ts.parseConfigFileTextToJson(rel, text);
  if (!config || typeof config !== "object") return null;

  const merged: EffectiveOptions = {};
  const parents = Array.isArray(config.extends)
    ? config.extends
    : typeof config.extends === "string"
      ? [config.extends]
      : [];
  for (const parent of parents) {
    if (typeof parent !== "string" || !parent.startsWith(".")) continue;
    const dir = path.posix.dirname(rel);
    let parentRel = normalizeRel(path.posix.join(dir, parent));
    if (parentRel.startsWith("..")) continue;
    if (!/\.json$/.test(parentRel)) parentRel += ".json";
    const inherited = await loadEffectiveOptions(read, parentRel, hops + 1, seen);
    if (inherited?.baseUrl) merged.baseUrl = inherited.baseUrl;
    if (inherited?.paths) merged.paths = inherited.paths;
  }

  const options = config.compilerOptions;
  const dir = path.posix.dirname(rel);
  if (options && typeof options === "object") {
    if (typeof options.baseUrl === "string") {
      merged.baseUrl = { value: options.baseUrl, dir: dir === "." ? "." : dir };
    }
    if (options.paths && typeof options.paths === "object") {
      merged.paths = { value: options.paths, dir: dir === "." ? "." : dir };
    }
  }
  return merged;
}

/**
 * Load one tsconfig into a matchable config, or null when it declares no
 * usable `paths` (directly or via `extends`).
 */
export async function loadTsPathsConfig(
  read: ReadTextFile,
  configRel: string,
): Promise<TsPathsConfig | null> {
  const effective = await loadEffectiveOptions(read, configRel, 0, new Set());
  if (!effective?.paths) return null;

  // Targets resolve against baseUrl when set (itself anchored to its
  // declaring config), else against the dir of the config declaring `paths`.
  const targetBase = effective.baseUrl
    ? normalizeRel(path.posix.join(effective.baseUrl.dir, effective.baseUrl.value))
    : effective.paths.dir;
  if (targetBase.startsWith("..")) return null;

  const patterns: TsPathPattern[] = [];
  for (const [pattern, targets] of Object.entries(effective.paths.value)) {
    if (!Array.isArray(targets)) continue;
    const stars = pattern.split("*").length - 1;
    if (stars > 1) continue; // TypeScript allows at most one `*` per pattern
    const starIdx = pattern.indexOf("*");
    const exact = starIdx < 0;
    const compiled = targets
      .filter((t): t is string => typeof t === "string" && t.split("*").length - 1 <= 1)
      .map((t) => normalizeRel(path.posix.join(targetBase, t)))
      .filter((t) => !t.startsWith(".."));
    if (!compiled.length) continue;
    patterns.push({
      prefix: exact ? pattern : pattern.slice(0, starIdx),
      suffix: exact ? "" : pattern.slice(starIdx + 1),
      exact,
      targets: compiled,
    });
  }
  if (!patterns.length) return null;

  // Longest matched prefix wins, exact patterns first — TS's selection order.
  patterns.sort((a, b) => Number(b.exact) - Number(a.exact) || b.prefix.length - a.prefix.length);
  const dir = path.posix.dirname(normalizeRel(configRel));
  return { dir: dir === "." ? "." : dir, patterns };
}

/** Deepest-config-first ordering, so the governing config is tried first. */
export function sortTsPathsConfigs(configs: TsPathsConfig[]): TsPathsConfig[] {
  return [...configs].sort((a, b) => b.dir.length - a.dir.length);
}

/**
 * Candidate workspace-relative base paths for a non-relative specifier, in
 * priority order (no extension probing — the caller owns that). Only configs
 * whose directory contains `fromRel` apply; the first config with a matching
 * pattern claims the specifier, matching TS's single-governing-config model.
 */
export function tsPathsCandidates(
  fromRel: string,
  specifier: string,
  configs: TsPathsConfig[],
): string[] {
  for (const config of configs) {
    if (config.dir !== "." && fromRel !== config.dir && !fromRel.startsWith(config.dir + "/")) {
      continue;
    }
    const out: string[] = [];
    for (const pattern of config.patterns) {
      let star: string;
      if (pattern.exact) {
        if (specifier !== pattern.prefix) continue;
        star = "";
      } else {
        if (
          specifier.length < pattern.prefix.length + pattern.suffix.length ||
          !specifier.startsWith(pattern.prefix) ||
          !specifier.endsWith(pattern.suffix)
        ) {
          continue;
        }
        star = specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length);
      }
      for (const target of pattern.targets) {
        const candidate = normalizeRel(target.replace("*", star));
        if (!candidate.startsWith("..")) out.push(candidate);
      }
      if (out.length) return out; // longest-prefix pattern claimed the match
    }
  }
  return [];
}
