import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeEnvironment } from "./preflight.js";

describe("probeEnvironment", () => {
  let dir: string;
  let binDir: string;

  // Probes run against a sealed PATH: platform is pinned to win32 (whose
  // fallback dirs all hang off env vars we leave unset, and whose access
  // check is existence-only, so plain fixture files count as executables),
  // home points into the temp root, and execPath is empty — nothing from the
  // host machine's real toolchain can leak in and flip an assertion.
  const sealed = (env: NodeJS.ProcessEnv) => ({
    env,
    platform: "win32" as const,
    home: path.join(dir, "nohome"),
    execPath: "",
  });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-preflight-"));
    binDir = path.join(dir, "bin");
    await fs.mkdir(binDir);
    for (const name of ["git.exe", "node.exe"]) {
      await fs.writeFile(path.join(binDir, name), "");
    }
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("diffs marker-implied needs against the resolvable PATH", async () => {
    const root = path.join(dir, "webapp");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "package.json"), "{}");
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");

    const report = await probeEnvironment(root, sealed({ PATH: binDir }));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get("git")?.ok).toBe(true);
    expect(byId.get("git")?.resolved).toContain("git.exe");
    expect(byId.get("node")?.ok).toBe(true);
    // The lockfile implied pnpm; the sealed PATH cannot resolve it.
    expect(byId.get("pnpm")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("a markerless root still checks git, and an unreadable root degrades to that", async () => {
    const bare = path.join(dir, "bare");
    await fs.mkdir(bare);
    const bareReport = await probeEnvironment(bare, sealed({ PATH: binDir }));
    expect(bareReport.checks.map((c) => c.id)).toEqual(["git"]);
    expect(bareReport.ok).toBe(true);

    const gone = await probeEnvironment(path.join(dir, "missing"), sealed({ PATH: binDir }));
    expect(gone.checks.map((c) => c.id)).toEqual(["git"]);
  });
});
