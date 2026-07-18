import { describe, expect, it } from "vitest";
import type { GitCommit, GitRefsResult } from "@crystal/core";
import { gitRefOptions } from "./git-refs.js";

const refs = (over: Partial<GitRefsResult> = {}): GitRefsResult => ({
  branches: ["feat/x", "main"],
  remoteBranches: ["origin/main"],
  tags: ["v1.0.0"],
  current: "main",
  worktrees: [],
  ...over,
});

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  subject: "fix: a thing",
  author: "dev",
  date: "2026-07-18T00:00:00Z",
  refs: [],
  ...over,
});

describe("gitRefOptions", () => {
  it("floats the current branch first and hints it", () => {
    const opts = gitRefOptions(refs());
    expect(opts[0]).toMatchObject({ value: "main", group: "Branches", hint: "current" });
    expect(opts[1]).toMatchObject({ value: "feat/x", group: "Branches" });
    expect(opts[1]!.hint).toBeUndefined();
  });

  it("keeps branch order when detached (no current)", () => {
    const opts = gitRefOptions(refs({ current: null }));
    expect(opts.map((o) => o.value).slice(0, 2)).toEqual(["feat/x", "main"]);
    expect(opts.every((o) => o.hint === undefined || o.group !== "Branches")).toBe(true);
  });

  it("groups remotes, tags and commits after branches", () => {
    const opts = gitRefOptions(refs(), [commit()]);
    expect(opts.map((o) => o.group)).toEqual(["Branches", "Branches", "Remote", "Tags", "Commits"]);
    expect(opts.at(-1)).toMatchObject({ value: "aaaaaaa", hint: "fix: a thing" });
  });

  it("truncates long commit subjects in the hint", () => {
    const subject = "feat: " + "x".repeat(60);
    const [only] = gitRefOptions(null, [commit({ subject })]);
    expect(only!.hint!.length).toBeLessThan(subject.length);
    expect(only!.hint!.endsWith("…")).toBe(true);
  });

  it("offers commits even without refs (empty or failed git.refs)", () => {
    const opts = gitRefOptions(null, [commit()]);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.group).toBe("Commits");
  });
});
