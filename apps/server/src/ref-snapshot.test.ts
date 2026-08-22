import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { overviewSourcesAtRef, snapshotAtRef } from "./ref-snapshot.js";

const execFileAsync = promisify(execFile);

describe("ref snapshots", () => {
  it("excludes generated paths from blob modules and overview sources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-ref-snapshot-"));
    try {
      await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
      await fs.mkdir(path.join(root, "src", "generated"), { recursive: true });
      await fs.mkdir(path.join(root, "src", "feature"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
      await fs.writeFile(path.join(root, "src", "feature", "keep.ts"), "export const keep = 1;\n");
      await fs.writeFile(
        path.join(root, "src", "generated", "client.ts"),
        "export const generated = 1;\n",
      );
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });

      const snapshot = await snapshotAtRef(root, ".", "HEAD");
      expect(snapshot.fileTotal).toBe(1);
      expect(snapshot.modules.map((module) => module.path)).not.toContain("src/generated");

      const overview = await overviewSourcesAtRef(root, ".", "HEAD");
      expect(overview.sources.map((source) => source.path)).toEqual(["src/feature/keep.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
