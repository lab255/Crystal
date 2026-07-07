/**
 * Server-local helpers. NOTE: `slugify` is a copy of the one in
 * `@ledgerline/shared` that predates the shared package — a hoist candidate.
 */

/** URL-safe slug: "ACME Corp." → "acme-corp". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Cap a string for log lines. */
export function truncate(input: string, max = 120): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}
