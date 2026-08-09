import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { nowIso, promptHeadline, type CreatePrResult } from "@crystal/core";
import { gitCurrentBranch, runGit } from "./git.js";

export interface PrIdentity {
  remote: string;
  branch: string;
  base: string;
}

export interface PrRecord {
  url: string;
  number: number;
  updatedAt: string;
}

interface StoredPr extends PrIdentity, PrRecord {}

interface PrFile {
  version: 1;
  entries: StoredPr[];
}

function sameIdentity(a: PrIdentity, b: PrIdentity): boolean {
  return a.remote === b.remote && a.branch === b.branch && a.base === b.base;
}

function validStoredPr(value: unknown): value is StoredPr {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.remote === "string" &&
    typeof row.branch === "string" &&
    typeof row.base === "string" &&
    typeof row.url === "string" &&
    typeof row.number === "number" &&
    Number.isInteger(row.number) &&
    row.number > 0 &&
    typeof row.updatedAt === "string"
  );
}

/** Workspace-owned PR identity store. Run records never carry PR URLs. */
export class PrStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredPr[] | null = null;

  constructor(private readonly dataDir: string) {}

  private file(): string {
    return path.join(this.dataDir, "pull-requests.json");
  }

  private async entries(): Promise<StoredPr[]> {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<PrFile>;
      this.cached = Array.isArray(parsed.entries) ? parsed.entries.filter(validStoredPr) : [];
    } catch {
      this.cached = [];
    }
    return this.cached;
  }

  async get(identity: PrIdentity): Promise<PrRecord | null> {
    const found = (await this.entries()).find((entry) => sameIdentity(entry, identity));
    return found
      ? { url: found.url, number: found.number, updatedAt: found.updatedAt }
      : null;
  }

  set(
    identity: PrIdentity,
    value: Omit<PrRecord, "updatedAt"> & { updatedAt?: string },
  ): Promise<PrRecord> {
    const task = this.queue.then(async () => {
      const record: PrRecord = { ...value, updatedAt: value.updatedAt ?? nowIso() };
      const entries = [...(await this.entries())];
      const index = entries.findIndex((entry) => sameIdentity(entry, identity));
      const stored = { ...identity, ...record };
      if (index === -1) entries.push(stored);
      else entries[index] = stored;
      await fs.mkdir(this.dataDir, { recursive: true });
      const file: PrFile = { version: 1, entries };
      await fs.writeFile(this.file(), JSON.stringify(file, null, 2), "utf8");
      this.cached = entries;
      return record;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const PROCESS_TIMEOUT_MS = 120_000;

/** Spawn without a shell: branch names and run-authored text remain argv data. */
function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Attach synchronously: an ENOENT error is emitted on the next tick.
    child.once("error", (err) => {
      finish(() =>
        reject(
          new ProcessError(
            err.message,
            (err as NodeJS.ErrnoException).code ?? null,
            stdout,
            stderr,
          ),
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          reject(
            new ProcessError(
              `${file} exited with code ${code ?? "unknown"}`,
              code,
              stdout,
              stderr,
            ),
          );
        }
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(new ProcessError(`${file} timed out`, "ETIMEDOUT", stdout, stderr)),
      );
    }, PROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}

function errorDetail(err: unknown): string {
  if (err instanceof ProcessError) return (err.stderr || err.stdout || err.message).trim();
  const value = err as Error & { stderr?: string; stdout?: string };
  return (value.stderr || value.stdout || value.message || String(err)).trim();
}

async function resolveRemote(worktreeAbs: string, branch: string): Promise<string | null> {
  const upstream = (
    await runGit(worktreeAbs, [
      "for-each-ref",
      "--format=%(upstream:remotename)",
      `refs/heads/${branch}`,
    ]).catch(() => "")
  ).trim();
  const remote = upstream && upstream !== "." ? upstream : "origin";
  const exists = await runGit(worktreeAbs, ["remote", "get-url", remote]).then(
    () => true,
    () => false,
  );
  return exists ? remote : null;
}

interface GhPr {
  url: string;
  number: number;
}

function parsePrList(stdout: string): GhPr | null {
  try {
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) return null;
    const first = rows[0] as Record<string, unknown> | undefined;
    return first && typeof first.url === "string" && typeof first.number === "number"
      ? { url: first.url, number: first.number }
      : null;
  } catch {
    return null;
  }
}

function prFromCreateOutput(stdout: string): GhPr | null {
  const url = stdout.match(/https?:\/\/\S+\/pull\/(\d+)/)?.[0]?.replace(/[),.;]+$/, "");
  const number = url?.match(/\/pull\/(\d+)/)?.[1];
  return url && number ? { url, number: Number(number) } : null;
}

export interface CreatePrInput {
  worktreeAbs: string;
  base: string;
  runId: string;
  prompt: string;
}

export interface CreatePrOptions {
  /** Test seam for a fake gh on PATH. */
  env?: NodeJS.ProcessEnv;
}

/** Push a branch and idempotently create (or find) its open PR. */
export async function createPr(
  store: PrStore,
  input: CreatePrInput,
  options: CreatePrOptions = {},
): Promise<CreatePrResult> {
  const dirty = (await runGit(input.worktreeAbs, ["status", "--porcelain"])).trim().length > 0;
  if (dirty) {
    return { ok: false, error: "The worktree has uncommitted changes — commit or discard first." };
  }
  const branch = await gitCurrentBranch(input.worktreeAbs);
  if (!branch) {
    return { ok: false, error: "The worktree is detached — apply it as a branch first." };
  }
  const remote = await resolveRemote(input.worktreeAbs, branch);
  if (!remote) return { ok: false, error: "No Git remote is configured for this branch." };

  try {
    await runProcess("gh", ["auth", "status"], { cwd: input.worktreeAbs, env: options.env });
  } catch (err) {
    if (err instanceof ProcessError && err.code === "ENOENT") {
      return { ok: false, error: "GitHub CLI (gh) is not installed." };
    }
    return {
      ok: false,
      error: `GitHub CLI is not authenticated. Run \`gh auth login\`.${errorDetail(err) ? ` ${errorDetail(err)}` : ""}`,
    };
  }

  try {
    await runGit(input.worktreeAbs, ["push", "-u", remote, branch]);
  } catch (err) {
    return { ok: false, error: `Push rejected: ${errorDetail(err)}` };
  }

  const identity: PrIdentity = { remote, branch, base: input.base };
  let listed: GhPr | null;
  try {
    const result = await runProcess(
      "gh",
      [
        "pr", "list",
        "--head", branch,
        "--base", input.base,
        "--state", "open",
        "--json", "url,number",
        "--limit", "1",
      ],
      { cwd: input.worktreeAbs, env: options.env },
    );
    listed = parsePrList(result.stdout);
  } catch (err) {
    return { ok: false, error: `Could not check existing pull requests: ${errorDetail(err)}` };
  }
  if (listed) {
    await store.set(identity, listed);
    return { ok: true, ...listed, existing: true };
  }

  const title = promptHeadline(input.prompt, 100) || `Crystal run ${input.runId}`;
  const body = `${title}\n\nCrystal run: ${input.runId}`;
  try {
    const result = await runProcess(
      "gh",
      [
        "pr", "create",
        "--head", branch,
        "--base", input.base,
        "--title", title,
        "--body", body,
      ],
      { cwd: input.worktreeAbs, env: options.env },
    );
    const created = prFromCreateOutput(result.stdout);
    if (!created) {
      return { ok: false, error: "GitHub CLI did not return a pull request URL." };
    }
    await store.set(identity, created);
    return { ok: true, ...created, existing: false };
  } catch (err) {
    return { ok: false, error: `Could not create pull request: ${errorDetail(err)}` };
  }
}
