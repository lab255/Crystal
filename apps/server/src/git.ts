import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeScope, GitCommit, GitRefsResult, GitStatusResult, GitSyncOp } from "@crystal/core";
import { resolveInRoot } from "./paths.js";

const exec = promisify(execFile);

/**
 * Never let a git subprocess sit waiting for credentials: the server has no
 * terminal, so an interactive prompt is a hang, not a question. Credential
 * helpers (manager, osxkeychain…) still work — only terminal/GUI askpass
 * prompts are refused.
 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };

/** Run git in a directory (absolute path), returning stdout. */
export async function runGit(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true, maxBuffer, env: GIT_ENV });
  return stdout;
}

export async function gitStatus(root: string, repoRel: string): Promise<GitStatusResult> {
  const cwd = resolveInRoot(root, repoRel);
  let stdout: string;
  try {
    ({ stdout } = await exec("git", ["status", "--porcelain=v1", "-b"], {
      cwd,
      windowsHide: true,
      env: GIT_ENV,
    }));
  } catch (err) {
    // Not being a repo is a state, not a failure — workspaces without version
    // control (or before the first `git init`) must not error the UI.
    const text = `${(err as { stderr?: string }).stderr ?? ""}${(err as Error).message ?? ""}`;
    if (text.includes("not a git repository")) {
      return {
        repoPath: repoRel,
        branch: null,
        files: [],
        isRepo: false,
        upstream: null,
        ahead: 0,
        behind: 0,
      };
    }
    throw err;
  }
  const lines = stdout.split("\n").filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusResult["files"] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      // "## branch...origin/branch [ahead 1, behind 2]" — branch, tracking
      // target and divergence all live in this one header line.
      const head = line.slice(3);
      const bracket = head.match(/ \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]$/);
      if (bracket) {
        ahead = Number(bracket[1] ?? 0);
        behind = Number(bracket[2] ?? 0);
      }
      const names = (bracket ? head.slice(0, bracket.index) : head).split("...");
      branch = names[0] ?? null;
      upstream = names[1] ?? null;
    } else {
      files.push({ code: line.slice(0, 2), path: line.slice(3).trim() });
    }
  }
  return { repoPath: repoRel, branch, files, isRepo: true, upstream, ahead, behind };
}

/** Network sync ops get a hard deadline — a stuck remote must not hold a bridge request forever. */
const SYNC_TIMEOUT_MS = 120_000;

async function runGitSync(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    windowsHide: true,
    env: GIT_ENV,
    timeout: SYNC_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  // git reports transfer/progress on stderr even on success — that's the
  // human-readable half of the story.
  return `${stdout}\n${stderr}`.trim();
}

/**
 * Fetch/pull/push against the repo's remote. Pull is `--ff-only`: a diverged
 * branch is a decision (merge? rebase?) the user makes in a terminal, not a
 * side effect of a toolbar button. Push auto-sets the upstream on a branch's
 * first push, so a fresh local branch "just pushes".
 */
export async function gitSync(
  root: string,
  repoRel: string,
  op: GitSyncOp,
): Promise<{ ok: true; summary: string; status: GitStatusResult }> {
  const cwd = resolveInRoot(root, repoRel);
  let summary: string;
  if (op === "fetch") {
    summary = await runGitSync(cwd, ["fetch", "--prune"]);
  } else if (op === "pull") {
    summary = await runGitSync(cwd, ["pull", "--ff-only"]);
  } else {
    try {
      summary = await runGitSync(cwd, ["push"]);
    } catch (err) {
      const text = `${(err as { stderr?: string }).stderr ?? ""}${(err as Error).message ?? ""}`;
      if (!text.includes("no upstream branch")) throw err;
      summary = await runGitSync(cwd, ["push", "--set-upstream", "origin", "HEAD"]);
    }
  }
  const status = await gitStatus(root, repoRel);
  return { ok: true, summary: summary || `${op} complete`, status };
}

/** Candidate main-branch names, tried in order, for the "base" diff scope. */
const MAIN_REFS = ["main", "master"] as const;

/**
 * The changed files a diff-scoped agent job should read, forward-slash and
 * repo-relative (matching the code index's paths).
 *
 * - "worktree" — uncommitted changes from `git status` (deletions dropped:
 *   there is nothing to read; renames resolve to the new path).
 * - "base" — this branch's committed diff against the main branch, via the
 *   merge-base (`git diff --name-only main...HEAD`). `base` echoes the ref that
 *   resolved, or null if neither `main` nor `master` exists.
 * - `ref` (overrides `scope`) — the working tree diffed against the
 *   merge-base of `ref` and HEAD (the ref itself when there is no merge-base,
 *   e.g. detached or unrelated histories). `base` echoes the ref.
 */
/**
 * Working tree vs merge-base(ref, HEAD), with per-file git statuses — the
 * status-bearing sibling of `changedFiles`'s ref branch, feeding the ref
 * review's added/modified/deleted marks. Renames count as delete + add so
 * both sides of the rename render truthfully.
 */
export async function changedFilesStatus(
  root: string,
  repoRel: string,
  ref: string,
): Promise<{ path: string; status: "added" | "modified" | "deleted" }[]> {
  const cwd = resolveInRoot(root, repoRel || ".");
  await gitResolveRef(cwd, ref); // loud on a typo'd/unfetched ref — see changedFiles
  let target = ref;
  try {
    target = (await runGit(cwd, ["merge-base", ref, "HEAD"])).trim() || ref;
  } catch {
    /* no merge-base — diff against the ref itself */
  }
  const out = await runGit(cwd, ["diff", "--name-status", "-M", target]);
  const files: { path: string; status: "added" | "modified" | "deleted" }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...paths] = line.split("\t");
    if (!code || paths.length === 0) continue;
    const kind = code[0];
    if (kind === "A") files.push({ path: paths[0]!, status: "added" });
    else if (kind === "D") files.push({ path: paths[0]!, status: "deleted" });
    else if (kind === "R" && paths.length >= 2) {
      files.push({ path: paths[0]!, status: "deleted" });
      files.push({ path: paths[1]!, status: "added" });
    } else files.push({ path: paths[paths.length - 1]!, status: "modified" });
  }
  return files;
}

export async function changedFiles(
  root: string,
  repoRel: string,
  scope: ChangeScope,
  ref?: string,
  ofRef?: string,
): Promise<{ files: string[]; base: string | null }> {
  // User-supplied refs resolve FIRST and failures propagate: a typo'd branch
  // must error like the vs review does, never read as "no changes" — an empty
  // diff lens is indistinguishable from a clean branch and gets reviews
  // approved on false evidence.
  if (ofRef) {
    // The committed changes `ofRef` itself introduced since forking from
    // HEAD — three-dot, so files only the main line touched stay out. This
    // is "what would this track branch merge", the other diffs' opposite.
    const cwd = resolveInRoot(root, repoRel || ".");
    await gitResolveRef(cwd, ofRef);
    const out = await runGit(cwd, ["diff", "--name-only", `HEAD...${ofRef}`]);
    return { files: out.split("\n").filter(Boolean), base: ofRef };
  }
  if (ref) {
    const cwd = resolveInRoot(root, repoRel || ".");
    await gitResolveRef(cwd, ref);
    let target = ref;
    try {
      target = (await runGit(cwd, ["merge-base", ref, "HEAD"])).trim() || ref;
    } catch {
      /* no merge-base — diff against the ref itself */
    }
    const out = await runGit(cwd, ["diff", "--name-only", target]);
    return { files: out.split("\n").filter(Boolean), base: ref };
  }
  if (scope === "worktree") {
    const { files } = await gitStatus(root, repoRel);
    const out = new Set<string>();
    for (const f of files) {
      if (f.code.includes("D")) continue; // deleted — nothing to read
      const arrow = f.path.indexOf(" -> "); // rename: "old -> new"
      out.add(arrow === -1 ? f.path : f.path.slice(arrow + 4));
    }
    return { files: [...out], base: null };
  }
  // "base": diff this branch against the main branch's merge-base.
  const cwd = resolveInRoot(root, repoRel || ".");
  let base: string | null = null;
  for (const ref of MAIN_REFS) {
    try {
      await gitResolveRef(cwd, ref);
      base = ref;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (!base) return { files: [], base: null };
  const out = await runGit(cwd, ["diff", "--name-only", `${base}...HEAD`]);
  return { files: out.split("\n").filter(Boolean), base };
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

/**
 * Every ref a picker can offer: local + remote branches, tags, worktrees and
 * the current branch. Remote branches keep their short form ("origin/main");
 * symbolic HEADs ("origin/HEAD") are dropped.
 */
export async function gitRefs(root: string, repoRel: string): Promise<GitRefsResult> {
  const cwd = resolveInRoot(root, repoRel || ".");
  const out = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)\t%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]).catch(() => "");
  const branches: string[] = [];
  const remoteBranches: string[] = [];
  const tags: string[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [short, full] = line.split("\t");
    if (!short || !full) continue;
    if (full.startsWith("refs/heads/")) branches.push(short);
    else if (full.startsWith("refs/tags/")) tags.push(short);
    else if (full.startsWith("refs/remotes/") && !short.endsWith("/HEAD")) remoteBranches.push(short);
  }
  const current = await gitCurrentBranch(cwd);
  const worktrees = await gitWorktrees(cwd);
  return { branches, remoteBranches, tags, current, worktrees };
}

/** The checked-out branch of a working tree, or null when detached / not a repo. */
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  const name = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  return name && name !== "HEAD" ? name : null;
}

/**
 * Linked worktrees of a repo (the main worktree included), with their branch
 * (porcelain records: "worktree <path>" / "branch refs/heads/x" / "detached").
 */
export async function gitWorktrees(cwd: string): Promise<GitRefsResult["worktrees"]> {
  const worktrees: GitRefsResult["worktrees"] = [];
  const out = await runGit(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
  let wtPath: string | null = null;
  for (const line of `${out}\n`.split("\n")) {
    if (line.startsWith("worktree ")) wtPath = line.slice(9).trim();
    else if (line.startsWith("branch ") && wtPath) {
      worktrees.push({ path: wtPath, branch: line.slice(7).trim().replace(/^refs\/heads\//, "") });
      wtPath = null;
    } else if (line === "detached" && wtPath) {
      worktrees.push({ path: wtPath, branch: null });
      wtPath = null;
    }
  }
  return worktrees;
}

/**
 * Switch the repo to a branch/ref (`git switch`, falling back to detached
 * checkout for tags/commits). Git itself refuses when the working tree would
 * conflict — the error surfaces to the caller untouched.
 */
export async function gitCheckout(
  root: string,
  repoRel: string,
  ref: string,
): Promise<{ ok: true; branch: string | null }> {
  const cwd = resolveInRoot(root, repoRel || ".");
  try {
    await runGit(cwd, ["switch", ref]);
  } catch {
    await runGit(cwd, ["switch", "--detach", ref]);
  }
  const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  return { ok: true, branch: branch && branch !== "HEAD" ? branch : null };
}

/** Resolve a ref to its short commit hash (throws on unknown refs). */
export async function gitResolveRef(cwd: string, ref: string): Promise<string> {
  try {
    return (await runGit(cwd, ["rev-parse", "--short", `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

/**
 * One file's content at a ref — the base side of a textual diff (and the only
 * way to read what a review ghost contained). `content: null` with
 * `truncated: false` means the path doesn't exist at that ref; with
 * `truncated: true` the blob exists but is over the byte cap. Throws on an
 * unknown ref (same loud contract as `changedFiles`) and on binary content.
 */
export async function showFileAtRef(
  root: string,
  repoRel: string,
  ref: string,
  filePath: string,
): Promise<{ content: string | null; truncated: boolean }> {
  const cwd = resolveInRoot(root, repoRel || ".");
  await gitResolveRef(cwd, ref);
  let size: number;
  try {
    size = Number((await runGit(cwd, ["cat-file", "-s", `${ref}:${filePath}`])).trim());
  } catch {
    return { content: null, truncated: false }; // path absent at this ref
  }
  if (!Number.isFinite(size) || size > CAT_FILE_MAX_BYTES) {
    return { content: null, truncated: true };
  }
  const content = await runGit(cwd, ["show", `${ref}:${filePath}`], CAT_FILE_MAX_BYTES + 1024 * 1024);
  if (content.includes("\0")) throw new Error(`Binary file at ${ref}: ${filePath}`);
  return { content, truncated: false };
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
    // git dying mid-batch EPIPEs pending stdin writes; without a listener the
    // stream's 'error' event is an uncaught exception that kills the server.
    // 'error'/'close' above already settle the promise.
    child.stdin.on("error", () => {});
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
    try {
      for (const path of paths) child.stdin.write(`${ref}:${path}\n`);
      child.stdin.end();
    } catch {
      /* stream torn down by a failed spawn — 'error'/'close' settle */
    }
  });
}
