import type { SystemModule } from "@crystal/core";

/**
 * file → owning system by longest part-path prefix (ties broken
 * lexicographically), memoized per file. The single attribution rule for the
 * whole surfaces mode — the provider's `systemOfFile` and the map's edge
 * targeting must agree or the canvas and the panes tell different stories.
 */
export function makeSystemAttributor(
  systems: readonly SystemModule[],
): (file: string) => SystemModule | null {
  const partIndex: { path: string; system: SystemModule }[] = [];
  for (const s of systems) for (const p of s.parts) partIndex.push({ path: p.path, system: s });
  partIndex.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const memo = new Map<string, SystemModule | null>();
  return (file: string): SystemModule | null => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    const found =
      partIndex.find((p) => file === p.path || file.startsWith(`${p.path}/`))?.system ?? null;
    memo.set(file, found);
    return found;
  };
}
