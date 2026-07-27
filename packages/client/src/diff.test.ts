import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

/**
 * The Changes pane trusts this parser to split `agent.diff`'s one raw blob
 * into per-file entries, so every git diff shape a worktree can produce is
 * pinned here: modify, add, delete, rename (with and without edits), binary,
 * quoted paths, and the degenerate empty/garbage cases.
 */

const MULTI_FILE = [
  "diff --git a/src/index.ts b/src/index.ts",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,4 +1,5 @@",
  ' import { app } from "./app.js";',
  "-const port = 3000;",
  "+const port = Number(process.env.PORT ?? 3000);",
  "+app.set(\"trust proxy\", true);",
  " ",
  " app.listen(port);",
  "@@ -20,3 +21,3 @@ export function shutdown() {",
  "-  server.close();",
  "+  server.close(() => process.exit(0));",
  "   // drain",
  " }",
  "diff --git a/docs/notes.md b/docs/notes.md",
  "new file mode 100644",
  "index 0000000..b1e6722",
  "--- /dev/null",
  "+++ b/docs/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+First line.",
  "\\ No newline at end of file",
  "diff --git a/legacy/old.js b/legacy/old.js",
  "deleted file mode 100644",
  "index 5d41402..0000000",
  "--- a/legacy/old.js",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-module.exports = {};",
  "-// dead",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("splits a multi-file blob into modified, added and deleted entries", () => {
    const files = parseUnifiedDiff(MULTI_FILE);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/index.ts", "modified"],
      ["docs/notes.md", "added"],
      ["legacy/old.js", "deleted"],
    ]);

    const [mod, added, deleted] = files;
    expect(mod!.hunks).toHaveLength(2);
    expect(mod!.additions).toBe(3);
    expect(mod!.deletions).toBe(2);
    expect(mod!.hunks[0]!.header).toBe("@@ -1,4 +1,5 @@");
    expect(mod!.hunks[1]!.header).toBe("@@ -20,3 +21,3 @@ export function shutdown() {");
    expect(mod!.hunks[0]!.lines[0]).toEqual({
      kind: "context",
      text: 'import { app } from "./app.js";',
    });
    expect(mod!.hunks[0]!.lines[1]).toEqual({ kind: "del", text: "const port = 3000;" });

    expect(added!.additions).toBe(2);
    expect(added!.deletions).toBe(0);
    // The no-newline marker is metadata, never a content line.
    expect(added!.hunks[0]!.lines).toHaveLength(2);

    expect(deleted!.additions).toBe(0);
    expect(deleted!.deletions).toBe(2);
    expect(deleted!.binary).toBe(false);
  });

  it("keeps a hunk's minus lines as content, not file headers", () => {
    // A deleted line that *looks* like a `---` header must stay hunk content.
    const blob = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,1 @@",
      "--- not a header, a deleted line",
      " kept",
    ].join("\n");
    const [file] = parseUnifiedDiff(blob);
    expect(file!.status).toBe("modified");
    expect(file!.hunks[0]!.lines[0]).toEqual({
      kind: "del",
      text: "-- not a header, a deleted line",
    });
  });

  it("parses a pure rename (no content change)", () => {
    const blob = [
      "diff --git a/src/util.ts b/src/helpers.ts",
      "similarity index 100%",
      "rename from src/util.ts",
      "rename to src/helpers.ts",
    ].join("\n");
    const [file] = parseUnifiedDiff(blob);
    expect(file).toMatchObject({
      path: "src/helpers.ts",
      oldPath: "src/util.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      binary: false,
    });
    expect(file!.hunks).toHaveLength(0);
  });

  it("parses a rename with edits", () => {
    const blob = [
      "diff --git a/lib/a.ts b/lib/b.ts",
      "similarity index 87%",
      "rename from lib/a.ts",
      "rename to lib/b.ts",
      "index 1111111..2222222 100644",
      "--- a/lib/a.ts",
      "+++ b/lib/b.ts",
      "@@ -1,1 +1,1 @@",
      "-export const NAME = \"a\";",
      "+export const NAME = \"b\";",
    ].join("\n");
    const [file] = parseUnifiedDiff(blob);
    expect(file).toMatchObject({
      path: "lib/b.ts",
      oldPath: "lib/a.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
    });
  });

  it("flags binary files and still attributes their paths", () => {
    const blob = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index e69de29..4b825dc 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "diff --git a/assets/new.png b/assets/new.png",
      "new file mode 100644",
      "index 0000000..4b825dc",
      "Binary files /dev/null and b/assets/new.png differ",
    ].join("\n");
    const files = parseUnifiedDiff(blob);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["assets/logo.png", "modified", true],
      ["assets/new.png", "added", true],
    ]);
    expect(files[0]!.hunks).toHaveLength(0);
  });

  it("unquotes paths with spaces", () => {
    const blob = [
      'diff --git "a/docs/read me.md" "b/docs/read me.md"',
      "index 1111111..2222222 100644",
      '--- "a/docs/read me.md"',
      '+++ "b/docs/read me.md"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const [file] = parseUnifiedDiff(blob);
    expect(file!.path).toBe("docs/read me.md");
    expect(file!.status).toBe("modified");
  });

  it("returns no files for an empty or whitespace blob", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n\n")).toEqual([]);
  });

  it("skips leading noise before the first file header", () => {
    const blob = [
      "warning: LF will be replaced by CRLF",
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const files = parseUnifiedDiff(blob);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("x.txt");
  });
});
