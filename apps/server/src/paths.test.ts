import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appDataDir, resolveInRoot, toRelPath, workspaceIdFor } from "./paths.js";

// resolveInRoot is the traversal guard for every workspace-scoped bridge
// method that takes a path — nothing else stands between a client-supplied
// string and the filesystem.
describe("resolveInRoot", () => {
  const root = path.join(os.tmpdir(), "crystal-paths-root");

  it("resolves relative paths inside the root", () => {
    expect(resolveInRoot(root, "src/index.ts")).toBe(path.join(root, "src", "index.ts"));
    expect(resolveInRoot(root, "src\\index.ts")).toBe(path.join(root, "src", "index.ts"));
  });

  it("resolves '.' and '' to the root itself", () => {
    expect(resolveInRoot(root, ".")).toBe(path.resolve(root));
    expect(resolveInRoot(root, "")).toBe(path.resolve(root));
  });

  it("treats a leading slash as workspace-relative, not filesystem-absolute", () => {
    expect(resolveInRoot(root, "/src/index.ts")).toBe(path.join(root, "src", "index.ts"));
  });

  it("blocks .. traversal out of the root", () => {
    expect(() => resolveInRoot(root, "../outside.txt")).toThrow(/escapes/);
    expect(() => resolveInRoot(root, "src/../../outside.txt")).toThrow(/escapes/);
    expect(() => resolveInRoot(root, "..\\outside.txt")).toThrow(/escapes/);
  });

  it("does not accept a sibling directory sharing the root as a prefix", () => {
    // root=".../app" must not admit ".../app-data" — the string-prefix check
    // needs the separator, and this pins that.
    expect(() => resolveInRoot(root, `../${path.basename(root)}-evil/x.txt`)).toThrow(/escapes/);
  });

  it("normalizes .. that stays inside the root", () => {
    expect(resolveInRoot(root, "src/../lib/util.ts")).toBe(path.join(root, "lib", "util.ts"));
  });
});

describe("workspace identity", () => {
  it("is stable and case-insensitive over the resolved root", () => {
    const a = workspaceIdFor("C:\\Repos\\App");
    expect(workspaceIdFor("c:\\repos\\app")).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("appDataDir embeds the workspace id, so the two can never drift", () => {
    for (const [root, rootPath] of [
      ["/repos/My App", path.posix],
      ["C:\\Repos\\My App", path.win32],
    ] as const) {
      expect(appDataDir(root, rootPath)).toContain(workspaceIdFor(root));
      // Unsafe basename characters are flattened, not passed to the filesystem.
      expect(path.basename(appDataDir(root, rootPath))).toBe(`My-App-${workspaceIdFor(root)}`);
    }
  });
});

describe("toRelPath", () => {
  it("emits forward slashes regardless of platform", () => {
    const root = path.join(os.tmpdir(), "crystal-rel-root");
    expect(toRelPath(root, path.join(root, "a", "b.ts"))).toBe("a/b.ts");
  });
});
