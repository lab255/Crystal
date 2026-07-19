import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager, claudeRunArgs, planClaudeSpawn } from "./agent-manager.js";

describe("claudeRunArgs", () => {
  it("pre-allows the crystal MCP server when an mcp-config is attached", () => {
    // Regression: headless (-p) runs cannot answer permission prompts, so
    // without --allowedTools every mcp__crystal__* call was declined
    // ("Claude requested permissions to use mcp__crystal__my_task…").
    const args = claudeRunArgs({ mcpConfigPath: "C:\\data\\mcp\\run_1.json" });
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("C:\\data\\mcp\\run_1.json");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    expect(allowed.startsWith("mcp__crystal,")).toBe(true);
    // Dev-loop commands ride every allowlist — a worker that cannot
    // `git commit` loses its work in the disposable worktree.
    expect(allowed).toContain("Bash(git commit *)");
    expect(allowed).toContain("Bash(npm test*)");
    // Outward-facing commands stay gated behind a human.
    expect(allowed).not.toContain("git push");
    expect(allowed).not.toContain("npm publish");
  });

  it("keeps the dev-loop allowlist (without mcp__crystal) when no mcp-config", () => {
    const args = claudeRunArgs({ model: "opus", resumeSessionId: "sess_1" });
    expect(args).not.toContain("--mcp-config");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    expect(allowed).not.toContain("mcp__crystal");
    expect(allowed).toContain("Bash(git commit *)");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_1");
  });
});

describe("planClaudeSpawn", () => {
  const ARGS = ["-p", "--mcp-config", "C:\\Users\\Eliot Lim\\.crystal\\mcp\\run_1.json"];

  it("spawns a Windows .exe directly, argv untouched", () => {
    const plan = planClaudeSpawn("C:\\Users\\Eliot Lim\\.local\\bin\\claude.exe", ARGS, true);
    expect(plan.shell).toBe(false);
    expect(plan.file).toBe("C:\\Users\\Eliot Lim\\.local\\bin\\claude.exe");
    expect(plan.args).toEqual(ARGS);
  });

  it("quotes space-carrying args on the Windows shell (.cmd shim) path", () => {
    const plan = planClaudeSpawn("claude", ARGS, true);
    expect(plan.shell).toBe(true);
    // The path with a space MUST be quoted — cmd.exe receives one
    // concatenated command line (this is the bug that broke every
    // manager dispatch: --mcp-config split at "Eliot Lim").
    expect(plan.args).toEqual(["-p", "--mcp-config", '"C:\\Users\\Eliot Lim\\.crystal\\mcp\\run_1.json"']);
  });

  it("quotes a shim path that itself contains spaces", () => {
    const plan = planClaudeSpawn("C:\\Program Files\\nodejs\\claude.cmd", ["-p"], true);
    expect(plan.shell).toBe(true);
    expect(plan.file).toBe('"C:\\Program Files\\nodejs\\claude.cmd"');
  });

  it("strips embedded quotes instead of letting them break the command line", () => {
    const plan = planClaudeSpawn("claude", ['a"b c'], true);
    expect(plan.args).toEqual(['"ab c"']);
  });

  it("never shells on POSIX", () => {
    const plan = planClaudeSpawn("claude", ARGS, false);
    expect(plan).toEqual({ file: "claude", args: ARGS, shell: false });
  });
});

describe("AgentManager spawn failure resilience", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  async function makeManager(claudeBin?: string): Promise<AgentManager> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-test-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    return new AgentManager(root, path.join(tmp, "data"), claudeBin);
  }

  it("settles a run with a nonexistent cwd as failed instead of crashing the process", async () => {
    // Regression: the spawn 'error' fires on the tick after spawn(); handlers
    // attached after an await miss it and the unhandled event killed the
    // whole bridge server (desktop sidecar crash, 2026-07-17).
    const mgr = await makeManager();
    const run = await mgr.start({ prompt: "noop", cwd: "does-not-exist-dir" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("failed");
    // Exactly one terminal status event — 'error' and 'close' both fire on a
    // failed spawn, but finish() must only settle once.
    const events = await mgr.eventsFor(run.id);
    const terminal = events.filter((e) => e.event.type === "status" && e.event.status !== "queued");
    expect(terminal).toHaveLength(1);
  });

  it("settles a run whose binary does not exist as failed (stdin write must not throw)", async () => {
    const missing = path.join(os.tmpdir(), "definitely-missing-crystal-claude.exe");
    const mgr = await makeManager(missing);
    const run = await mgr.start({ prompt: "noop" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("failed");
  });
});
