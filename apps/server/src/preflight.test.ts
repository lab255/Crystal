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

describe("probeAssertions", () => {
  let repo: string;

  beforeAll(async () => {
    const { probeAssertions } = await import("./preflight.js");
    void probeAssertions; // imported below per test; this warms the module
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-premise-"));
    const git = async (...args: string[]) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("git", args, { cwd: repo, windowsHide: true });
    };
    await git("init", "-b", "main");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await fs.writeFile(path.join(repo, "README.md"), "hello");
    await git("add", "-A");
    await git("commit", "-m", "init");
    await git("branch", "release/2.3");
  }, 30_000);

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("returns null when the text carries no assert lines", async () => {
    const { probeAssertions } = await import("./preflight.js");
    expect(await probeAssertions(repo, "just a goal, no claims")).toBeNull();
  });

  it("verifies branch/ref/file claims against the real repo", async () => {
    const { probeAssertions } = await import("./preflight.js");
    const report = await probeAssertions(
      repo,
      [
        "assert: branch release/2.3",
        "assert: branch does-not-exist",
        "assert: ref HEAD",
        "assert: ref deadbeefcafe",
        "assert: file README.md",
        "assert: file missing/file.txt",
      ].join("\n"),
    );
    expect(report).not.toBeNull();
    const byRaw = new Map(report!.checks.map((c) => [c.raw, c]));
    expect(byRaw.get("assert: branch release/2.3")?.ok).toBe(true);
    expect(byRaw.get("assert: branch does-not-exist")?.ok).toBe(false);
    expect(byRaw.get("assert: ref HEAD")?.ok).toBe(true);
    expect(byRaw.get("assert: ref deadbeefcafe")?.ok).toBe(false);
    expect(byRaw.get("assert: file README.md")?.ok).toBe(true);
    expect(byRaw.get("assert: file missing/file.txt")?.ok).toBe(false);
    expect(report!.ok).toBe(false);
  }, 30_000);

  it("fails unrecognized assertion kinds loudly instead of skipping them", async () => {
    const { probeAssertions } = await import("./preflight.js");
    const report = await probeAssertions(repo, "assert: pr 204 is green");
    expect(report!.checks).toHaveLength(1);
    expect(report!.checks[0]!.ok).toBe(false);
    expect(report!.checks[0]!.detail).toContain("unrecognized assertion");
  });

  it("cmd claims run in the workspace root and judge the exit code", async () => {
    const { probeAssertions } = await import("./preflight.js");
    const report = await probeAssertions(
      repo,
      "assert: cmd git rev-parse HEAD\nassert: cmd git rev-parse not-a-ref-here",
    );
    const [ok, bad] = report!.checks;
    expect(ok!.ok).toBe(true);
    expect(bad!.ok).toBe(false);
    expect(bad!.detail).toBeTruthy();
  }, 30_000);
});
