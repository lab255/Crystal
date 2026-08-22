import fs from "node:fs/promises";
import path from "node:path";
import { COMPOSE_BASENAMES, COMPOSE_OVERRIDE_BASENAMES, parseComposeFiles, type ComposeFileInput, type ComposeSuggestionResult } from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";

export const COMPOSE_MAX_FILES = 32;
export const COMPOSE_MAX_FILE_BYTES = 512 * 1024;
export const COMPOSE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const recognized = new Set<string>([...COMPOSE_BASENAMES, ...COMPOSE_OVERRIDE_BASENAMES]);

export async function discoverComposeFiles(root: string, readdir: typeof fs.readdir = fs.readdir): Promise<string[]> {
  const found: string[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(resolveInRoot(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && recognized.has(entry.name.toLowerCase())) found.push(child);
      if (entry.isDirectory() && depth < 2 && !entry.name.startsWith(".") && !isIgnoredDir(entry.name)) await walk(child, depth + 1);
    }
  }
  await walk("", 0);
  return found.sort((a, b) => a.localeCompare(b));
}

/** Deterministically keep bases and only same-directory overrides which have a base. */
export function pairComposePaths(paths: readonly string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  const dirsWithBase = new Set(sorted.filter((p) => (COMPOSE_BASENAMES as readonly string[]).includes(path.posix.basename(p).toLowerCase())).map(path.posix.dirname));
  return sorted.filter((p) => {
    const name = path.posix.basename(p).toLowerCase();
    return (COMPOSE_BASENAMES as readonly string[]).includes(name)
      || ((COMPOSE_OVERRIDE_BASENAMES as readonly string[]).includes(name) && dirsWithBase.has(path.posix.dirname(p)));
  });
}

export async function composeSuggestions(root: string): Promise<ComposeSuggestionResult> {
  const paths = pairComposePaths(await discoverComposeFiles(root));
  const diagnostics: ComposeSuggestionResult["diagnostics"] = [];
  const files: ComposeFileInput[] = [];
  let total = 0;
  for (const rel of paths) {
    if (files.length >= COMPOSE_MAX_FILES) { diagnostics.push({ path: rel, severity: "warning", message: `Compose file limit (${COMPOSE_MAX_FILES}) reached.` }); break; }
    const abs = resolveInRoot(root, rel);
    const stat = await fs.stat(abs);
    if (stat.size > COMPOSE_MAX_FILE_BYTES) { diagnostics.push({ path: rel, severity: "warning", message: `File exceeds ${COMPOSE_MAX_FILE_BYTES} byte read cap.` }); continue; }
    if (total + stat.size > COMPOSE_MAX_TOTAL_BYTES) { diagnostics.push({ path: rel, severity: "warning", message: `Total Compose read cap (${COMPOSE_MAX_TOTAL_BYTES} bytes) reached.` }); break; }
    files.push({ path: toRelPath(root, abs), content: await fs.readFile(abs, "utf8") });
    total += stat.size;
  }
  const result = parseComposeFiles(files);
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}
