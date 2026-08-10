import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowseEntry } from "@crystal/core";
import { isIgnoredDir } from "./paths.js";

/**
 * Expand a leading `~` against the *host's* home directory. Typed paths reach
 * the bridge without ever meeting a shell, so `~/Workspaces/thing` — which the
 * picker's own placeholder suggests — would otherwise resolve against the
 * server process's cwd and silently miss.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * List the sub-directories of an absolute host path — the open-workspace
 * folder browser. Any absolute path is listable (and `parent` walks up to the
 * filesystem root), so the picker can reach any folder on the machine, not
 * just what drilling down from home finds. Dot-dirs and build/dep dirs are
 * skipped; each entry is tagged with what makes it workspace-shaped
 * (`.crystal` > `.git` > `package.json`) so the picker can highlight likely
 * candidates.
 */
export async function browseDirs(
  p?: string,
): Promise<{ path: string; parent: string | null; entries: BrowseEntry[] }> {
  const target = path.resolve(p?.trim() ? expandHome(p.trim()) : os.homedir());
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries = (
    await Promise.all(
      dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !isIgnoredDir(d.name))
        .map(async (d): Promise<BrowseEntry> => {
          const abs = path.join(target, d.name);
          return { name: d.name, path: abs, marker: await markerOf(abs) };
        }),
    )
  ).sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}

async function markerOf(dir: string): Promise<BrowseEntry["marker"]> {
  if (await exists(path.join(dir, ".crystal"))) return "crystal";
  if (await exists(path.join(dir, ".git"))) return "repo";
  if (await exists(path.join(dir, "package.json"))) return "package";
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
