import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import {
  MergeConflictError,
  abortConflictResolution,
  buildConflictPrompt,
  findCheckoutDir,
  mergePreview,
  mergeWorktree,
  parseMergeTreeOutput,
  prepareConflictResolution,
  syncPreview,
  syncWorktree,
} from "./worktree-merge.js";
import { WorktreeOperationMutex } from "./worktree-operation-mutex.js";

let repo: string;
let worktree: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content, "utf8");
}

async function commit(dir: string, message: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c", "user.name=Test",
    "-c", "user.email=test@local",
    "commit", "-m", message, "--no-verify",
  );
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-merge-repo-"));
  worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "crystal-merge-wt-")), "wt");
  await git(repo, "init", "-b", "main");
  await write(repo, "a.txt", "base\n");
  await commit(repo, "base");
  await git(repo, "worktree", "add", "--detach", worktree);
});

afterEach(async () => {
  await runGit(repo, ["worktree", "remove", "--force", worktree]).catch(() => {});
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.dirname(worktree), { recursive: true, force: true }).catch(() => {});
});

describe("parseMergeTreeOutput", () => {
  it("extracts the tree oid and conflicted files, stopping at the blank line", () => {
    const out = "abc123\nsrc/a.ts\nsrc/b.ts\n\nAuto-merging src/a.ts\n";
    expect(parseMergeTreeOutput(out)).toEqual({
      tree: "abc123",
      conflicts: ["src/a.ts", "src/b.ts"],
    });
  });

  it("handles clean output (tree only)", () => {
    expect(parseMergeTreeOutput("abc123\n")).toEqual({ tree: "abc123", conflicts: [] });
  });
});

describe("mergePreview", () => {
  it("reports nothing to merge for a pristine worktree", async () => {
    const preview = await mergePreview(repo, worktree);
    expect(preview.target).toBe("main");
    expect(preview.canMerge).toBe(false);
    expect(preview.reason).toMatch(/nothing to merge/i);
  });

  it("counts ahead commits and flags dirty state", async () => {
    await write(worktree, "b.txt", "new\n");
    await commit(worktree, "add b");
    await write(worktree, "c.txt", "uncommitted\n");
    const preview = await mergePreview(repo, worktree);
    expect(preview.ahead).toBe(1);
    expect(preview.behind).toBe(0);
    expect(preview.dirty).toBe(true);
    expect(preview.canMerge).toBe(true);
  });

  it("predicts conflicts non-destructively when both sides touched a file", async () => {
    await write(worktree, "a.txt", "worktree change\n");
    await commit(worktree, "worktree side");
    await write(repo, "a.txt", "main change\n");
    await commit(repo, "main side");
    const preview = await mergePreview(repo, worktree);
    expect(preview.behind).toBe(1);
    if (!preview.predictionUnavailable) {
      expect(preview.conflicts).toContain("a.txt");
      expect(preview.canMerge).toBe(false);
    }
    // Prediction must not have touched either side.
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("main change\n");
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("worktree change\n");
  });

  it("rejects an unknown explicit target", async () => {
    const preview = await mergePreview(repo, worktree, "nope");
    expect(preview.canMerge).toBe(false);
    expect(preview.reason).toMatch(/no local branch/i);
  });
});

describe("mergeWorktree", () => {
  it("fast-forwards into the checked-out target, auto-committing dirty state", async () => {
    await write(worktree, "b.txt", "one\n");
    await commit(worktree, "add b");
    await write(worktree, "c.txt", "dirty\n"); // uncommitted — must ride along
    const result = await mergeWorktree(repo, worktree, { message: "land run" });
    expect(result.target).toBe("main");
    expect(result.fastForward).toBe(true);
    // The main checkout's working tree has the files (real merge, not ref surgery).
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe("one\n");
    expect(await fs.readFile(path.join(repo, "c.txt"), "utf8")).toBe("dirty\n");
  });

  it("creates a merge commit when the target advanced (clean merge)", async () => {
    await write(worktree, "b.txt", "worktree\n");
    await commit(worktree, "worktree side");
    await write(repo, "d.txt", "main\n");
    await commit(repo, "main side");
    const result = await mergeWorktree(repo, worktree, { message: "land run" });
    expect(result.fastForward).toBe(false);
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe("worktree\n");
    expect(await fs.readFile(path.join(repo, "d.txt"), "utf8")).toBe("main\n");
    const parents = (await git(repo, "log", "-1", "--pretty=%P")).trim().split(" ");
    expect(parents).toHaveLength(2);
  });

  it("throws MergeConflictError on predicted conflicts and mutates nothing", async () => {
    await write(worktree, "a.txt", "worktree change\n");
    await commit(worktree, "worktree side");
    await write(repo, "a.txt", "main change\n");
    await commit(repo, "main side");
    await expect(mergeWorktree(repo, worktree, { message: "land" })).rejects.toThrow(
      MergeConflictError,
    );
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("main change\n");
  });

  it("merges object-level when the target has no checkout (explicit target)", async () => {
    // Park the main checkout on another branch so `main` has no working tree.
    await git(repo, "switch", "-c", "elsewhere");
    await write(worktree, "b.txt", "track work\n");
    await commit(worktree, "track work");
    const result = await mergeWorktree(repo, worktree, { message: "land", target: "main" });
    expect(result.target).toBe("main");
    // main advanced without its (nonexistent) working tree being materialized.
    const tip = (await git(repo, "rev-parse", "main")).trim();
    expect(tip).toBe(result.mergedCommit);
    const files = await git(repo, "ls-tree", "--name-only", "main");
    expect(files).toContain("b.txt");
    // The user's checkout stayed untouched on its own branch.
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("elsewhere");
  });
});

describe("syncPreview", () => {
  it("reports a clean fast-forward when only the target advanced", async () => {
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");
    const before = (await git(worktree, "rev-parse", "HEAD")).trim();

    const preview = await syncPreview(repo, worktree);

    expect(preview).toMatchObject({
      target: "main",
      behind: 1,
      ahead: 0,
      dirty: false,
      canFastForward: true,
      conflicts: [],
    });
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(before);
    await expect(fs.access(path.join(worktree, "target.txt"))).rejects.toThrow();
  });

  it("counts both sides and predicts a clean divergent merge without mutating", async () => {
    await write(worktree, "run.txt", "run\n");
    await commit(worktree, "run side");
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");
    const before = (await git(worktree, "rev-parse", "HEAD")).trim();

    const preview = await syncPreview(repo, worktree);

    expect(preview.behind).toBe(1);
    expect(preview.ahead).toBe(1);
    expect(preview.canFastForward).toBe(false);
    expect(preview.conflicts).toEqual([]);
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(before);
    await expect(fs.access(path.join(worktree, "target.txt"))).rejects.toThrow();
  });

  it("predicts conflict files without changing HEAD, index, or file contents", async () => {
    await write(worktree, "a.txt", "run\n");
    await commit(worktree, "run side");
    await write(repo, "a.txt", "target\n");
    await commit(repo, "target side");
    const before = (await git(worktree, "rev-parse", "HEAD")).trim();

    const preview = await syncPreview(repo, worktree);

    expect(preview.behind).toBe(1);
    expect(preview.ahead).toBe(1);
    expect(preview.canFastForward).toBe(false);
    expect(preview.conflicts).toContain("a.txt");
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("run\n");
  });
});

describe("syncWorktree", () => {
  it("uses the ff-only tier for a clean worktree behind its target", async () => {
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");

    const result = await syncWorktree(repo, worktree);

    expect(result).toMatchObject({ ok: true, target: "main", fastForward: true, conflicts: [] });
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(
      (await git(repo, "rev-parse", "main")).trim(),
    );
    expect(await fs.readFile(path.join(worktree, "target.txt"), "utf8")).toBe("target\n");
  });

  it("creates a merge commit in the worktree for clean divergence", async () => {
    await write(worktree, "run.txt", "run\n");
    await commit(worktree, "run side");
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");

    const result = await syncWorktree(repo, worktree);

    expect(result).toMatchObject({ ok: true, target: "main", fastForward: false, conflicts: [] });
    expect(await fs.readFile(path.join(worktree, "run.txt"), "utf8")).toBe("run\n");
    expect(await fs.readFile(path.join(worktree, "target.txt"), "utf8")).toBe("target\n");
    expect((await git(worktree, "log", "-1", "--pretty=%P")).trim().split(" ")).toHaveLength(2);
  });

  it("materializes conflicts for the existing resolution and abort flow", async () => {
    await write(worktree, "a.txt", "run\n");
    await commit(worktree, "run side");
    await write(repo, "a.txt", "target\n");
    await commit(repo, "target side");

    const result = await syncWorktree(repo, worktree);

    expect(result).toMatchObject({ ok: true, target: "main", fastForward: false });
    if (!result.ok) throw new Error(result.error);
    expect(result.conflicts).toContain("a.txt");
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toContain("<<<<<<<");
    expect((await git(worktree, "rev-parse", "MERGE_HEAD")).trim()).toBeTruthy();
    // resolveConflicts calls this same primitive after sync; it must adopt,
    // not reject, the already-materialized merge state.
    const adopted = await prepareConflictResolution(repo, worktree, { commitMessage: "unused" });
    expect(adopted.conflicts).toContain("a.txt");
    await abortConflictResolution(worktree);
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("run\n");
  });

  it("returns a typed refusal for dirty or untracked work", async () => {
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");
    await write(worktree, "untracked.txt", "local\n");
    const before = (await git(worktree, "rev-parse", "HEAD")).trim();

    const result = await syncWorktree(repo, worktree);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toMatch(/commit or discard first/i);
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await fs.readFile(path.join(worktree, "untracked.txt"), "utf8")).toBe("local\n");
  });

  it("serializes two concurrent syncs through the per-worktree mutex", async () => {
    await write(repo, "target.txt", "target\n");
    await commit(repo, "target side");
    const mutex = new WorktreeOperationMutex();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = mutex.run(worktree, async () => {
      order.push("first:start");
      await gate;
      const result = await syncWorktree(repo, worktree);
      order.push("first:end");
      return result;
    });
    const second = mutex.run(worktree, async () => {
      order.push("second:start");
      const result = await syncWorktree(repo, worktree);
      order.push("second:end");
      return result;
    });

    await expect.poll(() => order).toEqual(["first:start"]);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("conflict resolution flow", () => {
  beforeEach(async () => {
    await write(worktree, "a.txt", "worktree change\n");
    await commit(worktree, "worktree side");
    await write(repo, "a.txt", "main change\n");
    await commit(repo, "main side");
  });

  it("prepares a reverse merge with markers, then lands as fast-forward once resolved", async () => {
    const prep = await prepareConflictResolution(repo, worktree, { commitMessage: "wip" });
    expect(prep.conflicts).toContain("a.txt");
    const conflicted = await fs.readFile(path.join(worktree, "a.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    // Resolve (as the agent would) and conclude the merge.
    await write(worktree, "a.txt", "merged both\n");
    await git(worktree, "add", "a.txt");
    await git(
      worktree,
      "-c", "user.name=Agent",
      "-c", "user.email=agent@local",
      "commit", "--no-edit", "--no-verify",
    );
    const result = await mergeWorktree(repo, worktree, { message: "land resolved" });
    expect(result.fastForward).toBe(true);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("merged both\n");
  });

  it("refuses to merge mid-resolution and aborts cleanly", async () => {
    await prepareConflictResolution(repo, worktree, { commitMessage: "wip" });
    await expect(mergeWorktree(repo, worktree, { message: "land" })).rejects.toThrow(
      /resolution is in progress/i,
    );
    await abortConflictResolution(worktree);
    expect(await fs.readFile(path.join(worktree, "a.txt"), "utf8")).toBe("worktree change\n");
    // Aborting twice is a no-op.
    await abortConflictResolution(worktree);
  });
});

describe("findCheckoutDir", () => {
  it("finds the main checkout and misses unchecked branches", async () => {
    expect(await findCheckoutDir(repo, "main")).toBeTruthy();
    expect(await findCheckoutDir(repo, "missing-branch")).toBeNull();
  });
});

describe("buildConflictPrompt", () => {
  it("lists the conflicted files and the commit instruction", () => {
    const prompt = buildConflictPrompt("main", ["a.txt", "b.txt"]);
    expect(prompt).toContain("a.txt");
    expect(prompt).toContain("git commit");
    expect(prompt).toContain('"main"');
  });
});
