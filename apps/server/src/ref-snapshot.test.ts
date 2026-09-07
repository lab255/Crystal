import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";

const execFileAsync = promisify(execFile);

describe("ref snapshots", () => {
  it("excludes generated paths from blob modules and overview sources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-ref-snapshot-"));
    const queue = new JobQueue(1);
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

      const snapshot = await queue.run("refArchSnapshot", [root, ".", "HEAD"], { timeoutMs: 10_000 });
      expect(snapshot.fileTotal).toBe(1);
      expect(snapshot.modules.map((module) => module.path)).not.toContain("src/generated");

      const overview = await queue.run("refOverviewSources", [root, ".", "HEAD"], { timeoutMs: 10_000 });
      expect(overview.sources.map((source) => source.path)).toEqual(["src/feature/keep.ts"]);
      const surfaces = await queue.run("refSurfacesSnapshot", [root, ".", "HEAD"], { timeoutMs: 10_000 });
      for (const dto of [snapshot, overview, surfaces]) expect(structuredClone(dto)).toEqual(dto);
      expect(surfaces.sources.map((source) => source.path)).toEqual(["src/feature/keep.ts"]);
    } finally {
      queue.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
