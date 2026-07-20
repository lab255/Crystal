import { z } from "zod";
import { uid } from "./ids.js";
import { parseLensTags } from "./code-index.js";

/**
 * The lens — Crystal's one cross-tool filter. A lens names a slice of the
 * codebase (a facet of dimensional tags, a saved workspace facet, or a review
 * diff) and every mode renders through it: the code map and systems overview
 * dim non-members, the surfaces views badge and filter to it, quality scopes
 * tests and coverage to it. The active lens travels at the *top level* of the
 * deep link (like `ws`), so it survives mode switches and rides shared URLs.
 *
 * Pure TS: the spec ↔ URL codec, the persisted workspace-facet registry
 * (`.crystal/facets.json`), and membership matching. Resolving a spec into
 * concrete member files needs the bridge (code index, git) and lives in
 * `@crystal/client`'s lens store.
 */

/** What a diff lens compares: uncommitted work, the branch vs its base, or vs an explicit ref. */
export type LensDiffScope = "worktree" | "base" | { ref: string };

export type LensSpec =
  /** Dimensional tags (`intent:auth`) and/or system ids (`sys:forms`) — the facet grammar. */
  | { kind: "tags"; tags: string[] }
  /** A saved workspace facet from `.crystal/facets.json`. */
  | { kind: "facet"; id: string }
  /** A review diff — membership is the changed-file set. */
  | { kind: "diff"; scope: LensDiffScope };

const LensDiffScopeSchema: z.ZodType<LensDiffScope> = z.union([
  z.literal("worktree"),
  z.literal("base"),
  z.object({ ref: z.string() }),
]);

export const LensSpecSchema: z.ZodType<LensSpec> = z.union([
  z.object({ kind: z.literal("tags"), tags: z.array(z.string()) }),
  z.object({ kind: z.literal("facet"), id: z.string() }),
  z.object({ kind: z.literal("diff"), scope: LensDiffScopeSchema }),
]);

/* ------------------------------------------------------------------ */
/* URL codec                                                           */
/* ------------------------------------------------------------------ */

/**
 * Serialize a spec for the `lens` deep-link param. Tag lenses keep the
 * historical comma-separated grammar (old `#/architect/codemap?lens=intent:x`
 * links parse into the same lens they always meant); diff and saved-facet
 * lenses use `diff:` / `facet:` prefixes no dimensional tag collides with.
 */
export function formatLensParam(spec: LensSpec): string {
  if (spec.kind === "facet") return `facet:${spec.id}`;
  if (spec.kind === "diff") {
    if (spec.scope === "worktree") return "diff:worktree";
    if (spec.scope === "base") return "diff:base";
    return `diff:ref:${spec.scope.ref}`;
  }
  return spec.tags.join(",");
}

/** Parse the `lens` param back into a spec. Empty or blank input yields null. */
export function parseLensParam(raw: string | null | undefined): LensSpec | null {
  const s = raw?.trim();
  if (!s) return null;
  if (s.startsWith("facet:")) {
    const id = s.slice("facet:".length);
    return id ? { kind: "facet", id } : null;
  }
  if (s.startsWith("diff:")) {
    const rest = s.slice("diff:".length);
    if (rest === "worktree") return { kind: "diff", scope: "worktree" };
    if (rest === "base") return { kind: "diff", scope: "base" };
    if (rest.startsWith("ref:")) {
      const ref = rest.slice("ref:".length);
      return ref ? { kind: "diff", scope: { ref } } : null;
    }
    return null;
  }
  const tags = parseLensTags(s);
  return tags.length > 0 ? { kind: "tags", tags } : null;
}

/* ------------------------------------------------------------------ */
/* Workspace facets (.crystal/facets.json)                             */
/* ------------------------------------------------------------------ */

/**
 * A saved, named lens that spans every tool — workspace-level, unlike the
 * per-diagram `ArchFacet` (which filters one drawing by node ids). Its spec
 * is a tags or diff lens; a facet can't point at another facet.
 */
export const WorkspaceFacetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  spec: LensSpecSchema.refine((s) => s.kind !== "facet", {
    message: "a workspace facet cannot reference another facet",
  }),
});
export type WorkspaceFacet = z.infer<typeof WorkspaceFacetSchema>;

export const WorkspaceFacetsFileSchema = z.object({
  facets: z.array(WorkspaceFacetSchema).default([]),
});
export type WorkspaceFacetsFile = z.infer<typeof WorkspaceFacetsFileSchema>;

export function createWorkspaceFacet(name: string, spec: LensSpec): WorkspaceFacet {
  if (spec.kind === "facet") throw new Error("a workspace facet cannot reference another facet");
  return { id: uid("facet"), name, description: "", spec };
}

/** Display label for a lens chip. `facets` names saved-facet lenses. */
export function lensLabel(spec: LensSpec, facets?: readonly WorkspaceFacet[]): string {
  if (spec.kind === "facet") {
    return facets?.find((f) => f.id === spec.id)?.name ?? "Saved facet";
  }
  if (spec.kind === "diff") {
    if (spec.scope === "worktree") return "Working tree changes";
    if (spec.scope === "base") return "Diff vs base branch";
    return `Diff vs ${spec.scope.ref}`;
  }
  return spec.tags.join(", ");
}

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

/**
 * A resolved lens: the concrete member set views match against. `files` are
 * workspace-relative paths; `dirs` are directory prefixes (system parts —
 * a `sys:` tag means "everything under these trees").
 */
export interface LensMembership {
  files: string[];
  dirs: string[];
  /** Resolved base ref of a diff lens (null when it couldn't be resolved). */
  base?: string | null;
}

/**
 * Membership tests, precomputed once per resolution. `empty` means the lens
 * resolved to nothing (e.g. a clean working tree) — views should say so
 * rather than render an unfiltered screen that pretends to be filtered.
 */
export interface LensMatcher {
  readonly empty: boolean;
  /** Is this workspace-relative file a member? */
  file(path: string): boolean;
  /** Does the lens touch anything under this directory? */
  under(dir: string): boolean;
}

const MATCH_NOTHING: LensMatcher = { empty: true, file: () => false, under: () => false };

export function buildLensMatcher(membership: LensMembership | null | undefined): LensMatcher {
  const files = membership?.files ?? [];
  const dirs = membership?.dirs ?? [];
  if (files.length === 0 && dirs.length === 0) return MATCH_NOTHING;
  const fileSet = new Set(files);
  const dirPrefixes = dirs.map((d) => (d.endsWith("/") ? d : `${d}/`));
  return {
    empty: false,
    file(path) {
      if (fileSet.has(path)) return true;
      return dirPrefixes.some((p) => path.startsWith(p));
    },
    under(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      for (const f of files) if (f.startsWith(prefix)) return true;
      return dirPrefixes.some((p) => p.startsWith(prefix) || prefix.startsWith(p));
    },
  };
}

/**
 * Which systems a lens touches: a system is a member when any of its parts
 * (directory subtrees) contains a member file or overlaps a member dir.
 */
export function systemsInLens(
  systems: readonly { id: string; parts: readonly { path: string }[] }[],
  matcher: LensMatcher,
): Set<string> {
  const out = new Set<string>();
  if (matcher.empty) return out;
  for (const sys of systems) {
    if (sys.parts.some((p) => matcher.under(p.path))) out.add(sys.id);
  }
  return out;
}
