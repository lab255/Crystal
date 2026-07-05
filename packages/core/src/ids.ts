/** ID helpers. Uses Web Crypto, available in both modern browsers and Node >= 19. */

export function uid(prefix?: string): string {
  const raw = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "untitled"
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
