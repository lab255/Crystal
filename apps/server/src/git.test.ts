import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitStatus, gitSync, runGit } from "./git.js";

/**
 * Remote sync against a local bare repo — the whole pull/push/fetch surface
 * without touching the network. Layout: `remote.git` (bare) with two clones,
 * `work` (the workspace under test) and `other` (the second author).
 */
describe("git sync", () => {
  let base: string;
  let remote: string;
  let work: string;
  let other: string;

  async function commit(cwd: string, file: string, content: string): Promise<void> {
    writeFileSync(join(cwd, file), content);
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", `add ${file}`]);
  }

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "crystal-git-"));
    remote = join(base, "remote.git");
    work = join(base, "work");
    other = join(base, "other");
    await runGit(base, ["init", "--bare", "-b", "main", remote]);
    for (const clone of [work, other]) {
      await runGit(base, ["clone", remote, clone]);
      await runGit(clone, ["config", "user.email", "test@crystal.dev"]);
      await runGit(clone, ["config", "user.name", "Crystal Test"]);
    }
    await commit(work, "a.txt", "one");
    await runGit(work, ["push", "-u", "origin", "main"]);
  }, 60_000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reports upstream and ahead/behind from the status header", async () => {
    let status = await gitStatus(work, ".");
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);

    await commit(work, "b.txt", "two");
    status = await gitStatus(work, ".");
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
  });

  it("push clears the ahead count and lands on the remote", async () => {
    const res = await gitSync(work, ".", "push");
    expect(res.ok).toBe(true);
    expect(res.status.ahead).toBe(0);
    expect(await runGit(remote, ["log", "--format=%s", "main"])).toContain("add b.txt");
  });

  it("fetch surfaces behind, pull fast-forwards it away", async () => {
    await runGit(other, ["pull", "--ff-only"]);
    await commit(other, "c.txt", "three");
    await runGit(other, ["push"]);

    const fetched = await gitSync(work, ".", "fetch");
    expect(fetched.status.behind).toBe(1);

    const pulled = await gitSync(work, ".", "pull");
    expect(pulled.status.behind).toBe(0);
    expect(await runGit(work, ["log", "--format=%s", "-1"])).toContain("add c.txt");
  });

  it("ff-only pull refuses a diverged branch instead of minting a merge", async () => {
    await commit(other, "d.txt", "theirs");
    await runGit(other, ["push"]);
    await commit(work, "e.txt", "ours");

    await expect(gitSync(work, ".", "pull")).rejects.toThrow();
    // The local commit survives untouched.
    expect(await runGit(work, ["log", "--format=%s", "-1"])).toContain("add e.txt");
    // Recover for later tests: rebase and push both sides together.
    await runGit(work, ["pull", "--rebase"]);
    await runGit(work, ["push"]);
  });

  it("first push of a new branch sets the upstream", async () => {
    await runGit(work, ["switch", "-c", "feature"]);
    await commit(work, "f.txt", "feature work");
    const before = await gitStatus(work, ".");
    expect(before.upstream).toBeNull();

    const res = await gitSync(work, ".", "push");
    expect(res.status.upstream).toBe("origin/feature");
    expect(res.status.ahead).toBe(0);
    await runGit(work, ["switch", "main"]);
  });

  it("treats a non-repo directory as a state, not an error", async () => {
    const status = await gitStatus(base, ".");
    expect(status.isRepo).toBe(false);
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBe(0);
  });
});
