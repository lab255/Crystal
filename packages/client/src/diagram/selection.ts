/**
 * The shared focus-filter vocabulary. Every diagram expresses "show me these
 * nodes (and optionally their neighbors)" as a comma-separated id list in a
 * deep-link param (`focus`, plus `solo` to hide the neighbor ring) — these
 * helpers are the one codec so ctrl/⌘-click, "Add to filter" menu entries and
 * selection chips behave identically across architecture, codebase and infra.
 */

export function parseIdList(param: string | null | undefined): string[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Canonical form: comma-joined, deduped, empty → null (param absent). */
export function formatIdList(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length ? out.join(",") : null;
}

/** Ctrl/⌘-click semantics: add when absent, remove when present. */
export function toggleIdInList(param: string | null | undefined, id: string): string | null {
  const ids = parseIdList(param);
  return formatIdList(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
}
