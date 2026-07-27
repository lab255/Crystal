import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentManager,
  claudeInteractiveArgs,
  claudeRunArgs,
  composeNoticePrompt,
  planClaudeSpawn,
} from "./agent-manager.js";

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

describe("claudeInteractiveArgs", () => {
  it("plans a TUI session, not a headless print run", () => {
    const args = claudeInteractiveArgs({
      model: "opus",
      sessionId: "11111111-2222-3333-4444-555555555555",
      mcpConfigPath: "C:\\data\\mcp\\run_1.json",
    });
    // No -p / stream-json — the TUI renders itself on the PTY.
    expect(args).not.toContain("-p");
    expect(args).not.toContain("stream-json");
    // The pinned session id is what keeps the chain resumable after the
    // terminal closes (the TUI never tells us its session id otherwise).
    expect(args[args.indexOf("--session-id") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    expect(allowed.startsWith("mcp__crystal,")).toBe(true);
    expect(allowed).toContain("Bash(git commit *)");
  });

  it("drops the mcp pre-allow when no config rides along", () => {
    const args = claudeInteractiveArgs({});
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("mcp__crystal");
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

describe("interactive sessions", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  async function makeManager(): Promise<AgentManager> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-interactive-test-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    // "node" resolves everywhere without the login-shell fallback; no process
    // is ever spawned by these tests (the host owns the PTY).
    return new AgentManager(root, path.join(tmp, "data"), "node", {
      baseUrl: "http://127.0.0.1:9",
      scope: "ws_test",
    });
  }

  it("prepares a task session: pinned session id, mcp config, interactive protocol", async () => {
    const mgr = await makeManager();
    const plan = await mgr.prepareInteractive({ prompt: "Fix the bug.", taskId: "task_1" });
    expect(plan.run.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(plan.args[plan.args.indexOf("--session-id") + 1]).toBe(plan.run.sessionId);
    // Task-bound → per-run mcp config on disk, endpoint carrying the run id.
    const cfgPath = plan.args[plan.args.indexOf("--mcp-config") + 1]!;
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
    expect(cfg.mcpServers.crystal.url).toContain(plan.run.id);
    // The typed-in prompt carries the paired ask flow, never as argv.
    expect(plan.args.join(" ")).not.toContain("Fix the bug.");
    expect(plan.prompt).toContain("Fix the bug.");
    expect(plan.prompt).toContain("ask_question");
    expect(plan.prompt).toContain("AskUserQuestion");
    expect(plan.prompt).toContain("resolve_question");
  });

  it("delivers into the live terminal, then settles on terminal exit", async () => {
    const mgr = await makeManager();
    mgr.interactiveReadyMs = 0; // no TUI mount window in tests
    const typed: string[] = [];
    mgr.interactiveInput = (run, text) => {
      typed.push(`${run.terminalId}:${text}`);
      return true;
    };
    const plan = await mgr.prepareInteractive({ prompt: "Go.", taskId: "task_1" });
    const run = await mgr.bindInteractive(plan.run.id, "term_1");
    expect(run.status).toBe("running");
    expect(run.terminalId).toBe("term_1");

    // deliver() types into the PTY instead of queueing/resuming.
    const delivered = await mgr.deliver(run.id, "Answer: yes, ship it.");
    expect(delivered?.id).toBe(run.id);
    expect(typed).toEqual(["term_1:Answer: yes, ship it."]);

    await mgr.settleInteractive("term_1", 0);
    expect((await mgr.get(run.id))?.status).toBe("completed");
    // Settling twice (kill + exit event) must not double-finish.
    await mgr.settleInteractive("term_1", 1);
    expect((await mgr.get(run.id))?.status).toBe("completed");
  });

  it("disposeAll cancels a live interactive run and kills its terminal", async () => {
    // Regression target: closing a workspace used to leave agent children
    // alive — a "cancelled" delivery with a live orchestrator still in it.
    const mgr = await makeManager();
    const killed: string[] = [];
    mgr.interactiveKill = (run) => {
      killed.push(run.terminalId!);
    };
    const plan = await mgr.prepareInteractive({ prompt: "Go.", taskId: "task_1" });
    const run = await mgr.bindInteractive(plan.run.id, "term_3");
    mgr.disposeAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(killed).toEqual(["term_3"]);
    // Failed, not cancelled: resumeChain refuses cancelled chains forever,
    // which would wedge managers (and their hub locks) on workspace close.
    expect((await mgr.get(run.id))?.status).toBe("failed");
    // A disposed manager spawns nothing new into the closed workspace.
    await expect(mgr.start({ prompt: "nope" })).rejects.toThrow(/closed/);
  });

  it("queues deliveries during the TUI mount window and flushes them when ready", async () => {
    const mgr = await makeManager();
    mgr.interactiveReadyMs = 120;
    const typed: string[] = [];
    mgr.interactiveInput = (run, text) => {
      typed.push(text);
      return true;
    };
    const plan = await mgr.prepareInteractive({ prompt: "Go.", taskId: "task_1" });
    const run = await mgr.bindInteractive(plan.run.id, "term_4");
    // Inside the mount window: typing now would mangle the paste — queue it.
    const delivered = await mgr.deliver(run.id, "Answer: early bird");
    expect(delivered).toBeNull();
    expect(typed).toEqual([]);
    // The bind-time flush timer delivers it once the TUI is ready.
    await new Promise((r) => setTimeout(r, 400));
    expect(typed).toEqual(["Answer: early bird"]);
  });

  it("cancel kills the terminal and reads cancelled, not failed", async () => {
    const mgr = await makeManager();
    const killed: string[] = [];
    mgr.interactiveKill = (run) => {
      killed.push(run.terminalId!);
      // The host's kill surfaces as a terminal exit next.
      void mgr.settleInteractive(run.terminalId!, null);
    };
    const plan = await mgr.prepareInteractive({ prompt: "Go.", taskId: "task_1" });
    const run = await mgr.bindInteractive(plan.run.id, "term_2");
    await mgr.cancel(run.id);
    expect(killed).toEqual(["term_2"]);
    expect((await mgr.get(run.id))?.status).toBe("cancelled");
  });
});

describe("applyWorktree", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const git = async (cwd: string, args: string[]) => {
    const { runGit } = await import("./git.js");
    return runGit(cwd, args);
  };

  it("lands a detached worktree's changes as a branch + commit visible from the repo", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-apply-test-"));
    const repo = path.join(tmp, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@crystal"]);
    await git(repo, ["config", "user.name", "Crystal Test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "init"]);

    const mgr = new AgentManager(repo, path.join(tmp, "data"), "node");
    // A settled run with a real detached worktree, as isolation would leave it.
    const worktree = path.join(tmp, "wt");
    await git(repo, ["worktree", "add", "--detach", worktree]);
    await fs.writeFile(path.join(worktree, "a.txt"), "two\n");
    await fs.writeFile(path.join(worktree, "new.txt"), "brand new\n");
    // A cheap settled run record (spawn fails instantly), then point it at
    // the prepared worktree — list() hands back the live record objects.
    const run = await mgr.start({ prompt: "noop", cwd: "does-not-exist-dir" });
    await mgr.waitForSettled(run.id);
    const record = (await mgr.list())[0]!;
    record.worktreePath = worktree;

    const result = await mgr.applyWorktree(record.id, { branch: "crystal/test-apply" });
    expect(result).toMatchObject({ ok: true, branch: "crystal/test-apply" });
    // The branch (and both files) are visible from the main repo.
    const show = await git(repo, ["show", "crystal/test-apply:a.txt"]);
    expect(show).toContain("two");
    const files = await git(repo, ["show", "--name-only", "--format=", "crystal/test-apply"]);
    expect(files).toContain("new.txt");
    // Applying again with nothing new refuses cleanly.
    const again = await mgr.applyWorktree(record.id, {});
    expect(again.ok).toBe(false);
  });
});

describe("composeNoticePrompt", () => {
  it("carries each notice's text — not the notice object", () => {
    // Regression: the notices used to be joined directly, so every manager
    // wake-up read "[object Object]" and the whole delegation loop was blind.
    const prompt = composeNoticePrompt([
      { kind: "worker", text: "Worker run_1 settled: completed" },
      { kind: "worker", text: "Worker run_2 settled: failed" },
    ]);
    expect(prompt).toContain("Worker run_1 settled: completed");
    expect(prompt).toContain("Worker run_2 settled: failed");
    expect(prompt).not.toContain("[object Object]");
    expect(prompt).toContain("2 workers settled while you were away.");
    expect(prompt).toContain("do not busy-poll worker_status");
  });

  it("does not frame a queued message as a settlement", () => {
    // An answer or a steer speaks for itself; telling the agent it was
    // "resumed because dispatched work settled" would send it to the board.
    const prompt = composeNoticePrompt([
      { kind: "message", text: "Answer to your question: ship it behind a flag." },
    ]);
    expect(prompt).toBe("Answer to your question: ship it behind a flag.");
  });

  it("keeps the settlement tail when the two kinds are mixed", () => {
    const prompt = composeNoticePrompt([
      { kind: "message", text: "OWNER MESSAGE: reprioritise." },
      { kind: "worker", text: "Worker run_1 settled: completed" },
    ]);
    expect(prompt).toContain("OWNER MESSAGE: reprioritise.");
    expect(prompt).toContain("Worker run_1 settled: completed");
    expect(prompt).toContain("You were resumed because dispatched work settled");
    // One worker, so no "N workers settled" header.
    expect(prompt).not.toMatch(/^\d+ workers settled/);
  });
});
