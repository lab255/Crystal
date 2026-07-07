/**
 * Dimensional tags — plain strings with an optional `dimension:value` shape
 * (e.g. `epic:board-v2`, `area:server`, `source:draft`). Tasks, agent runs
 * and agent profiles all carry tag arrays so work can be attributed and
 * measured along any axis; a bare tag ("ux") simply has no dimension.
 */

/** The dimension of a tag (`"area:server"` → `"area"`), or null for bare tags. */
export function tagDimension(tag: string): string | null {
  const idx = tag.indexOf(":");
  return idx > 0 ? tag.slice(0, idx) : null;
}

/** The value of a tag (`"area:server"` → `"server"`; bare tags are their own value). */
export function tagValue(tag: string): string {
  const idx = tag.indexOf(":");
  return idx > 0 ? tag.slice(idx + 1) : tag;
}

/** Distinct dimensions present in a tag set, sorted. */
export function tagDimensions(tags: Iterable<string>): string[] {
  const dims = new Set<string>();
  for (const tag of tags) {
    const dim = tagDimension(tag);
    if (dim) dims.add(dim);
  }
  return [...dims].sort();
}

/** Values a tag set holds in one dimension (`["area:server","ux"]`, `"area"` → `["server"]`). */
export function tagsInDimension(tags: Iterable<string>, dimension: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tagDimension(tag) === dimension) out.push(tagValue(tag));
  }
  return out;
}

/** Tags present in both sets (exact string match, deduplicated). */
export function tagOverlap(a: Iterable<string>, b: Iterable<string>): string[] {
  const set = new Set(a);
  return [...new Set(b)].filter((tag) => set.has(tag));
}
