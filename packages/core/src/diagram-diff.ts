/**
 * The one diff vocabulary every diagram shares.
 *
 * A ref review ("vs <ref>") renders the head state of a diagram with marks
 * describing how it differs from the base: `added` tints new things,
 * `removed` renders base-only things as ghosts merged into the scene before
 * layout (so deletions occupy space instead of vanishing), `changed` tints
 * survivors whose content shifted. Marks are keyed by the same stable ids the
 * scene builders use (`m:`/`f:`/`s:` on the code map, canonical `sys:`/
 * `screen:`/`ep:`/`ext:` ids on the architecture views, `dep:` edges), so
 * decorating a scene is a lookup, never a re-derivation.
 *
 * Everything here is pure data — marks travel into scene web workers, so no
 * functions, no Maps.
 */

export type DiffMarkKind = "added" | "removed" | "changed";

export interface DiffMark {
  kind: DiffMarkKind;
  /** True when the marked item exists only at the base and renders as a ghost. */
  ghost?: boolean;
  /** Short human note for tooltips/panels, e.g. "12 → 30 files". */
  detail?: string;
}

/** Marks keyed by stable scene/canonical id. Plain record — worker-safe. */
export type DiffMarks = Record<string, DiffMark>;

export interface GhostMerge<T> {
  /** Head items in head order, then base-only ghosts in base order. */
  items: T[];
  marks: DiffMarks;
}

/**
 * Merge two versions of an item list into one renderable list plus marks:
 * head-only items are `added`, base-only items are appended as `removed`
 * ghosts (they must exist in the scene to be laid out), and items present on
 * both sides are `changed` when the caller's comparator says so — returning
 * a string doubles as the mark's `detail`.
 */
export function mergeGhosts<T>(
  base: readonly T[],
  head: readonly T[],
  id: (item: T) => string,
  changed?: (before: T, after: T) => boolean | string,
): GhostMerge<T> {
  const marks: DiffMarks = {};
  const baseById = new Map<string, T>();
  for (const item of base) baseById.set(id(item), item);
  const headIds = new Set<string>();
  const items: T[] = [];
  for (const item of head) {
    const key = id(item);
    headIds.add(key);
    items.push(item);
    const before = baseById.get(key);
    if (before === undefined) {
      marks[key] = { kind: "added" };
    } else if (changed) {
      const delta = changed(before, item);
      if (delta) {
        marks[key] = { kind: "changed" };
        if (typeof delta === "string") marks[key].detail = delta;
      }
    }
  }
  for (const item of base) {
    const key = id(item);
    if (headIds.has(key)) continue;
    items.push(item);
    marks[key] = { kind: "removed", ghost: true };
  }
  return { items, marks };
}

/** Tallies for chips/badges ("+4 −2 ~7"). */
export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export function countMarks(marks: DiffMarks): DiffCounts {
  const counts: DiffCounts = { added: 0, removed: 0, changed: 0 };
  for (const mark of Object.values(marks)) counts[mark.kind]++;
  return counts;
}

/** "+4 −2 ~7" — empty string when nothing differs. */
export function formatDiffCounts(counts: DiffCounts): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`+${counts.added}`);
  if (counts.removed) parts.push(`−${counts.removed}`);
  if (counts.changed) parts.push(`~${counts.changed}`);
  return parts.join(" ");
}
