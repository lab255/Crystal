import { describe, expect, it } from "vitest";
import {
  baseSideFromRead,
  currentPathForDiff,
  currentSideFromRead,
  pairDiffSides,
  shapeDiffRequest,
  sideFromError,
} from "./diff-view.js";

describe("diff request shaping", () => {
  it("accepts the event contract and normalizes repo paths", () => {
    const request = shapeDiffRequest({
      path: " src\\index.ts ",
      ref: " main ",
      repoPath: " packages\\app/ ",
    });
    expect(request).toEqual({ path: "src/index.ts", ref: "main", repoPath: "packages/app" });
    expect(currentPathForDiff(request!)).toBe("packages/app/src/index.ts");
  });

  it("rejects requests without both a path and ref", () => {
    expect(shapeDiffRequest({ path: "a.ts" })).toBeNull();
    expect(shapeDiffRequest({ ref: "main" })).toBeNull();
    expect(shapeDiffRequest(null)).toBeNull();
  });

  it("keeps root-repo paths workspace relative", () => {
    const request = shapeDiffRequest({ path: "src/a.ts", ref: "HEAD", repoPath: "." });
    expect(request).toEqual({ path: "src/a.ts", ref: "HEAD" });
    expect(currentPathForDiff(request!)).toBe("src/a.ts");
  });
});

describe("base/current pairing", () => {
  it("pairs textual sides without changing their contents", () => {
    const state = pairDiffSides(
      baseSideFromRead({ content: "before\n", truncated: false }),
      currentSideFromRead({ content: "after\n", truncated: false }),
    );
    expect(state).toEqual({
      kind: "ready",
      original: "before\n",
      modified: "after\n",
      notes: [],
    });
  });

  it("uses an empty left side for a file absent at the ref", () => {
    const state = pairDiffSides(
      baseSideFromRead({ content: null, truncated: false }),
      currentSideFromRead({ content: "new\n", truncated: false }),
    );
    expect(state).toMatchObject({ kind: "ready", original: "", modified: "new\n" });
    if (state.kind === "ready") expect(state.notes[0]).toMatch(/Absent at ref/);
  });

  it("uses an empty right side when the worktree file was deleted", () => {
    const state = pairDiffSides(
      baseSideFromRead({ content: "old\n", truncated: false }),
      sideFromError(new Error("ENOENT: no such file or directory"), "current"),
    );
    expect(state).toMatchObject({ kind: "ready", original: "old\n", modified: "" });
    if (state.kind === "ready") expect(state.notes[0]).toMatch(/Deleted from the worktree/);
  });

  it("classifies a path absent on both sides as an empty state", () => {
    expect(pairDiffSides({ kind: "absent" }, { kind: "absent" })).toMatchObject({
      kind: "empty",
      title: "File absent on both sides",
    });
  });
});

describe("unavailable diff states", () => {
  it("classifies either truncated side without rendering partial text", () => {
    expect(
      pairDiffSides(
        baseSideFromRead({ content: null, truncated: true }),
        currentSideFromRead({ content: "current", truncated: false }),
      ),
    ).toMatchObject({ kind: "unavailable", reason: "truncated" });
    expect(
      pairDiffSides(
        baseSideFromRead({ content: "base", truncated: false }),
        currentSideFromRead({ content: "partial", truncated: true }),
      ),
    ).toMatchObject({ kind: "unavailable", reason: "truncated" });
  });

  it("classifies narrow bridge binary errors", () => {
    const binary = sideFromError(new Error("Binary file at main: image.png"), "base");
    expect(binary).toMatchObject({ kind: "binary" });
    expect(pairDiffSides(binary, { kind: "text", content: "" })).toMatchObject({
      kind: "unavailable",
      reason: "binary",
    });
  });

  it("keeps unrelated read failures as errors", () => {
    const failure = sideFromError(new Error("Permission denied"), "current");
    expect(failure).toEqual({ kind: "error", message: "Permission denied" });
    expect(pairDiffSides({ kind: "text", content: "base" }, failure)).toMatchObject({
      kind: "unavailable",
      reason: "error",
    });
  });
});
