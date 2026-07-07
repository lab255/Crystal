import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { GitCommit, GitStatusResult } from "@crystal/core";
import { resolveInRoot } from "./paths.js";

const exec = promisify(execFile);

/** Run git in a directory (absolute path), returning stdout. */
export async function runGit(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true, maxBuffer });
  return stdout;
}

export async function gitStatus(root: string, repoRel: string): Promise<GitStatusResult> {
  const cwd = resolveInRoot(root, repoRel);
  const { stdout } = await exec("git", ["status", "--porcelain=v1", "-b"], {
    cwd,
    windowsHide: true,
  });
  const lines = stdout.split("\n").filter(Boolean);
  let branch: string | null = null;
  const files: GitStatusResult["files"] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0] ?? null;
    } else {
      files.push({ code: line.slice(0, 2), path: line.slice(3).trim() });
    }
  }
  return { repoPath: repoRel, branch, files };
}

/** Field / record separators for machine-readable `git log` output. */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

export async function gitLog(
  root: string,
  repoRel: string,
  limit = 30,
): Promise<{ commits: GitCommit[]; branch: string | null }> {
  const cwd = resolveInRoot(root, repoRel || ".");
  const capped = Math.max(1, Math.min(limit, 200));
  // %x1f / %x1e make git emit the separator bytes itself.
  const format = ["%H", "%h", "%an", "%aI", "%D", "%s"].join("%x1f") + "%x1e";
  const out = await runGit(cwd, [
    "log",
    `--max-count=${capped}`,
    `--pretty=format:${format}`,
  ]).catch(() => ""); // empty repo / not a repo → no commits
  const commits: GitCommit[] = [];
  for (const record of out.split(RECORD_SEP)) {
    const [hash, shortHash, author, date, decorations, subject] = record
      .replace(/^\n/, "")
      .split(FIELD_SEP);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
      refs: (decorations ?? "")
        .split(",")
        .map((r) => r.trim().replace(/^HEAD -> /, ""))
        .filter((r) => r && r !== "HEAD"),
    });
  }
  const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""))
    .trim();
  return { commits, branch: branch && branch !== "HEAD" ? branch : null };
}

/** Resolve a ref to its short commit hash (throws on unknown refs). */
export async function gitResolveRef(cwd: string, ref: string): Promise<string> {
  try {
    return (await runGit(cwd, ["rev-parse", "--short", `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

/** All blob paths in the tree at `ref` (forward-slash, repo-relative). */
export async function gitLsTree(cwd: string, ref: string, maxBuffer = 32 * 1024 * 1024): Promise<string[]> {
  const out = await runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", ref], maxBuffer);
  return out.split("\0").filter(Boolean);
}

/** Per-file byte cap for `gitCatFiles` — larger blobs are skipped. */
const CAT_FILE_MAX_BYTES = 1.5 * 1024 * 1024;
/** Total byte cap across one `gitCatFiles` call. */
const CAT_FILE_TOTAL_BYTES = 96 * 1024 * 1024;

/**
 * Read many blobs at one ref through a single `git cat-file --batch` process
 * (per-file `git show` would be thousands of process spawns on Windows).
 * Missing paths are simply absent from the result.
 */
export function gitCatFiles(
  cwd: string,
  ref: string,
  paths: string[],
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd, windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > CAT_FILE_TOTAL_BYTES) {
        child.kill();
        reject(new Error(`Ref snapshot exceeds ${CAT_FILE_TOTAL_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      const out = new Map<string, string>();
      let offset = 0;
      // Responses come back in request order: "<oid> <type> <size>\n<body>\n"
      // or "<request> missing\n".
      for (const path of paths) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl === -1) break;
        const header = buf.subarray(offset, nl).toString("utf8");
        offset = nl + 1;
        if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
        const size = Number(header.split(" ")[2] ?? NaN);
        if (!Number.isFinite(size)) break; // out of sync — stop rather than misattribute
        if (size <= CAT_FILE_MAX_BYTES) {
          out.set(path, buf.subarray(offset, offset + size).toString("utf8"));
        }
        offset += size + 1; // trailing LF after the body
      }
      resolve(out);
    });
    for (const path of paths) child.stdin.write(`${ref}:${path}\n`);
    child.stdin.end();
  });
}
