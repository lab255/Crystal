import fs from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const abs = resolveInRoot(root, rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    if (d.isDirectory() && isIgnoredDir(d.name)) continue;
    const absChild = path.join(abs, d.name);
    const entry: FileEntry = {
      name: d.name,
      path: toRelPath(root, absChild),
      kind: d.isDirectory() ? "dir" : "file",
    };
    if (!d.isDirectory()) {
      const stat = await fs.stat(absChild).catch(() => null);
      if (stat) entry.size = stat.size;
    }
    entries.push(entry);
  }
  entries.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return entries;
}

export async function readFileCapped(
  root: string,
  rel: string,
): Promise<{ content: string; truncated: boolean }> {
  const abs = resolveInRoot(root, rel);
  const stat = await fs.stat(abs);
  const truncated = stat.size > MAX_READ_BYTES;
  const handle = await fs.open(abs, "r");
  try {
    const size = Math.min(stat.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    if (buf.includes(0)) {
      throw new Error(`Binary file: ${rel}`);
    }
    return { content: buf.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

export async function writeFileAt(root: string, rel: string, content: string): Promise<void> {
  const abs = resolveInRoot(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

export async function mkdirAt(root: string, rel: string): Promise<void> {
  await fs.mkdir(resolveInRoot(root, rel), { recursive: true });
}

export async function renameAt(root: string, from: string, to: string): Promise<void> {
  const target = resolveInRoot(root, to);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(resolveInRoot(root, from), target);
}

export async function deleteAt(root: string, rel: string): Promise<void> {
  const abs = resolveInRoot(root, rel);
  if (abs === path.resolve(root)) throw new Error("Refusing to delete workspace root");
  await fs.rm(abs, { recursive: true, force: true });
}
