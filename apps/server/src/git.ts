import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatusResult } from "@crystal/core";
import { resolveInRoot } from "./paths.js";

const exec = promisify(execFile);

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
