import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import { createPr, PrStore } from "./pr-manager.js";

let tmp: string;
let repo: string;
let worktree: string;
let remote: string;
let binDir: string;
let ghLog: string;
let ghState: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(cwd, file), content, "utf8");
  await git(cwd, "add", "-A");
  await git(
    cwd,
    "-c", "user.name=Test",
    "-c", "user.email=test@local",
    "commit", "-m", message, "--no-verify",
  );
}

async function fakeGh(): Promise<NodeJS.ProcessEnv> {
  const executable = path.join(binDir, "gh");
  await fs.writeFile(
    executable,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
      '  if [ -f "$FAKE_GH_STATE" ]; then',
      '    printf \'[{"url":"https://example.test/acme/repo/pull/17","number":17}]\\n\'',
      "  else",
      "    printf '[]\\n'",
      "  fi",
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  : > "$FAKE_GH_STATE"',
      "  printf 'https://example.test/acme/repo/pull/17\\n'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_STATE: ghState,
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-pr-"));
  repo = path.join(tmp, "repo");
  worktree = path.join(tmp, "worktree");
  remote = path.join(tmp, "remote.git");
  binDir = path.join(tmp, "bin");
  ghLog = path.join(tmp, "gh.log");
  ghState = path.join(tmp, "open-pr");
  await Promise.all([fs.mkdir(repo), fs.mkdir(binDir), fs.mkdir(remote)]);
  await git(repo, "init", "-b", "main");
  await commit(repo, "base.txt", "base\n", "base");
  await git(remote, "init", "--bare");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "worktree", "add", "-b", "feature/wp-d", worktree);
  await commit(worktree, "feature.txt", "feature\n", "feature");
});

afterEach(async () => {
  await runGit(repo, ["worktree", "remove", "--force", worktree]).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(process.platform === "win32")("createPr", () => {
  it("pushes, passes the base explicitly, creates once, then finds the open PR", async () => {
    const env = await fakeGh();
    const store = new PrStore(path.join(tmp, "data"));

    const created = await createPr(
      store,
      {
        worktreeAbs: worktree,
        base: "main",
        runId: "run_123",
        prompt: "Implement WP-D\nwith more detail",
      },
      { env },
    );
    expect(created).toEqual({
      ok: true,
      url: "https://example.test/acme/repo/pull/17",
      number: 17,
      existing: false,
    });
    expect((await git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}")).trim()).toBe(
      "origin/feature/wp-d",
    );

    const existing = await createPr(
      store,
      {
        worktreeAbs: worktree,
        base: "main",
        runId: "run_123",
        prompt: "Implement WP-D",
      },
      { env },
    );
    expect(existing).toEqual({
      ok: true,
      url: "https://example.test/acme/repo/pull/17",
      number: 17,
      existing: true,
    });

    const log = await fs.readFile(ghLog, "utf8");
    expect(log).toContain("pr list --head feature/wp-d --base main --state open");
    expect(log).toContain("pr create --head feature/wp-d --base main --title Implement WP-D");
    expect(log.match(/^pr create /gm)).toHaveLength(1);
  });

  it("refuses a dirty worktree before invoking gh or pushing", async () => {
    const env = await fakeGh();
    await fs.writeFile(path.join(worktree, "dirty.txt"), "dirty\n", "utf8");
    const result = await createPr(
      new PrStore(path.join(tmp, "data")),
      { worktreeAbs: worktree, base: "main", runId: "run_dirty", prompt: "Dirty" },
      { env },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toMatch(/commit or discard first/i);
    await expect(fs.access(ghLog)).rejects.toThrow();
    await expect(git(worktree, "rev-parse", "@{upstream}")).rejects.toThrow();
  });

  it("returns a typed error when gh is not installed", async () => {
    const emptyPath = path.join(tmp, "empty-path");
    await fs.mkdir(emptyPath);
    const result = await createPr(
      new PrStore(path.join(tmp, "data")),
      { worktreeAbs: worktree, base: "main", runId: "run_no_gh", prompt: "No gh" },
      { env: { ...process.env, PATH: emptyPath } },
    );
    expect(result).toEqual({ ok: false, error: "GitHub CLI (gh) is not installed." });
  });
});

describe("PrStore", () => {
  it("round-trips records by remote, branch, and base", async () => {
    const dataDir = path.join(tmp, "store-data");
    const identity = { remote: "origin", branch: "feature/wp-d", base: "main" };
    const store = new PrStore(dataDir);
    await store.set(identity, {
      url: "https://example.test/acme/repo/pull/17",
      number: 17,
      updatedAt: "2026-08-09T00:00:00.000Z",
    });

    const reloaded = new PrStore(dataDir);
    expect(await reloaded.get(identity)).toEqual({
      url: "https://example.test/acme/repo/pull/17",
      number: 17,
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await reloaded.get({ ...identity, base: "release" })).toBeNull();
  });
});
