import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Content identity of the whole on-disk file (not just the capped read) —
 * `fs.read` hands it to the client, `fs.write` compares it so a buffer loaded
 * before an agent (or anything else) rewrote the file can't silently clobber
 * that newer content. Null when the file doesn't exist.
 */
async function fileShaAt(abs: string): Promise<string | null> {
  try {
    return crypto.createHash("sha256").update(await fs.readFile(abs)).digest("hex");
  } catch {
    return null;
  }
}

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
): Promise<{ content: string; truncated: boolean; sha: string }> {
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
    const sha = truncated
      ? ((await fileShaAt(abs)) ?? "")
      : crypto.createHash("sha256").update(buf).digest("hex");
    return { content: buf.toString("utf8"), truncated, sha };
  } finally {
    await handle.close();
  }
}

export async function writeFileAt(
  root: string,
  rel: string,
  content: string,
  baseSha?: string,
): Promise<void> {
  const abs = resolveInRoot(root, rel);
  if (baseSha !== undefined) {
    const current = await fileShaAt(abs);
    // A vanished file isn't a conflict — writing it back restores it. Only a
    // *different* on-disk content means someone else wrote since the read.
    if (current !== null && current !== baseSha) {
      throw new Error(
        `Conflict: ${rel} changed on disk since it was loaded — reload before saving`,
      );
    }
  }
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
