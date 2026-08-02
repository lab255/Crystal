import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentManager,
  claudeInteractiveArgs,
  claudeRunArgs,
  claudeSpawnEnv,
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
    // Only the crystal server loads — the user's global/project MCP servers
    // are ignored for this scoped run.
    expect(args).toContain("--strict-mcp-config");
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
    expect(args).not.toContain("--strict-mcp-config"); // no config → no strict flag
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    expect(allowed).not.toContain("mcp__crystal");
    expect(allowed).toContain("Bash(git commit *)");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_1");
  });

  it("threads the profile policy: append prompt, permission mode, tool lists", () => {
    const args = claudeRunArgs({
      appendSystemPrompt: "Only review; never edit files.",
      permissionMode: "plan",
      allowedTools: ["Bash(semgrep *)", "Bash(git commit *)"],
      disallowedTools: ["Write", "Edit", "Write"],
    });
    // The standing prompt is a flag (it must survive --resume turns); the
    // task prompt itself still travels on stdin, never argv.
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Only review; never edit files.");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    // Profile additions merge over the dev-loop allowlist, deduped.
    expect(allowed).toContain("Bash(semgrep *)");
    expect(allowed.match(/Bash\(git commit \*\)/g)).toHaveLength(1);
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Write,Edit");
  });

  it("keeps today's defaults when no policy is set", () => {
    const args = claudeRunArgs({});
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--disallowedTools");
  });

  it("passes bypassPermissions through — the workspace gate runs before argv is built", () => {
    const args = claudeRunArgs({ permissionMode: "bypassPermissions" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
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

  it("threads the profile policy exactly like headless runs", () => {
    const args = claudeInteractiveArgs({
      appendSystemPrompt: "Standing orders.",
      permissionMode: "default",
      allowedTools: ["Bash(semgrep *)"],
      disallowedTools: ["WebSearch"],
    });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Standing orders.");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Bash(semgrep *)");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("WebSearch");
  });
});

describe("claudeSpawnEnv", () => {
  it("strips ANTHROPIC_API_KEY so subscription logins can't silently bill per-token", () => {
    const env = claudeSpawnEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-leaked" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.FORCE_COLOR).toBe("0");
  });

  it("keeps the key when the user opts in", () => {
    const env = claudeSpawnEnv({ ANTHROPIC_API_KEY: "sk-ant-mine", CRYSTAL_ALLOW_API_KEY: "1" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-mine");
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

  it("quotes a multi-word --append-system-prompt on the .cmd/shell path", () => {
    // A profile's standing prompt is the first arg with spaces that is user
    // text, not a path — cmd.exe concatenates argv unquoted, so it must go
    // through the same winShellQuote as everything else.
    const args = claudeRunArgs({ appendSystemPrompt: 'Only "review"; never edit.' });
    const plan = planClaudeSpawn("claude", args, true);
    const i = plan.args.indexOf("--append-system-prompt");
    expect(plan.args[i + 1]).toBe('"Only review; never edit."');
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

describe("runsWithTag", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("serves tagged runs from the index, at creation and after a reload", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-tag-test-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const data = path.join(tmp, "data");
    // A missing binary settles every run instantly — tags persist regardless.
    const missing = path.join(tmp, "missing-claude.exe");
    const mgr = new AgentManager(root, data, missing);

    const a = await mgr.start({ prompt: "one", tags: ["workflow:wf_1"] });
    const b = await mgr.start({ prompt: "two", tags: ["workflow:wf_1", "team:x"] });
    const other = await mgr.start({ prompt: "three", tags: ["team:x"] });
    await Promise.all([a, b, other].map((r) => mgr.waitForSettled(r.id)));

    const tagged = await mgr.runsWithTag("workflow:wf_1");
    expect(tagged.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await mgr.runsWithTag("no-such-tag")).toEqual([]);

    // A fresh manager over the same app data rebuilds the index from disk —
    // spend metering must survive a server restart.
    const reloaded = new AgentManager(root, data, missing);
    const again = await reloaded.runsWithTag("workflow:wf_1");
    expect(again.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("dispatchWorker agent profiles", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("resolves the spec's agentId through the profile resolver; explicit model wins", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-dispatch-agent-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    // A missing binary settles runs instantly — the record still carries the
    // resolved dispatch config, which is all this test reads.
    const mgr = new AgentManager(root, path.join(tmp, "data"), path.join(tmp, "missing.exe"));
    mgr.profileResolver = async (agentId) =>
      agentId === "sec"
        ? {
            agentId: "sec",
            model: "sonnet",
            skills: ["security-review"],
            appendPrompt: "Only review.",
            allowedTools: [],
            disallowedTools: ["Write"],
            permissionMode: "plan",
            defaults: { purpose: "security-review" },
            extraTags: ["agent:sec"],
          }
        : null;

    const manager = await mgr.start({ prompt: "coordinate", role: "manager" });
    const worker = await mgr.dispatchWorker(manager.id, {
      prompt: "Audit the auth flow.",
      agentId: "sec",
    });
    expect(worker).not.toBeNull();
    expect(worker!.model).toBe("sonnet");
    expect(worker!.agentId).toBe("sec");
    expect(worker!.purpose).toBe("security-review");
    expect(worker!.tags).toContain("agent:sec");

    const explicit = await mgr.dispatchWorker(manager.id, {
      prompt: "Audit again.",
      agentId: "sec",
      model: "opus",
    });
    expect(explicit!.model).toBe("opus"); // spec's explicit model beats the profile's
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

  it("keeps deliveries queued when the TUI dies before becoming a session", async () => {
    // The pinned --session-id of a TUI that never booted points at nothing:
    // a --resume of it would consume queued deliveries into a turn that can
    // only die. A failed exit with no transcript unpins the session instead,
    // so the chain reads unresumable and the messages survive.
    const mgr = await makeManager();
    mgr.interactiveReadyMs = 60_000; // never ready — deliveries must queue
    const plan = await mgr.prepareInteractive({ prompt: "Go.", taskId: "task_1" });
    const run = await mgr.bindInteractive(plan.run.id, "term_5");
    expect(await mgr.deliver(run.id, "Answer: queued")).toBeNull();

    await mgr.settleInteractive("term_5", 1);
    const settled = await mgr.get(run.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.sessionId).toBeNull();
    // No doomed --resume consumed the queue — the chain stayed a single run.
    expect(await mgr.chainRuns(run.id)).toHaveLength(1);
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

// A stand-in Claude CLI: consumes stdin, prints canned stream-json, exits.
async function writeFakeClaude(dir: string, lines: string[], exitCode: number): Promise<string> {
  const bin = path.join(dir, "fake-claude.sh");
  await fs.writeFile(
    bin,
    ["#!/bin/sh", "cat > /dev/null", ...lines.map((l) => `echo '${l}'`), `exit ${exitCode}`].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

const INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"sess_fake","model":"fake-model","cwd":".","tools":[]}';

describe.skipIf(process.platform === "win32")("recoverable failures and handoff", () => {
  let tmp: string;

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function makeManager(lines: string[], exitCode: number): Promise<AgentManager> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-fake-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = await writeFakeClaude(tmp, lines, exitCode);
    return new AgentManager(root, path.join(tmp, "data"), bin);
  }

  it("classifies a context-overflow failure from the result text", async () => {
    const mgr = await makeManager(
      [
        INIT_LINE,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 400 prompt is too long: 210000 tokens > 200000 maximum","session_id":"sess_fake","num_turns":1,"duration_ms":5}',
      ],
      1,
    );
    const run = await mgr.start({ prompt: "long task" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("failed");
    expect(settled.failure?.kind).toBe("context_overflow");
    // The terminal status event carries the recovery hint. waitForSettled
    // resolves on the result event — finish() (and its status event) lands on
    // process close, a tick later, so poll.
    await expect
      .poll(async () =>
        (await mgr.eventsFor(run.id)).some(
          (e) => e.event.type === "status" && /hand off/i.test(e.event.message ?? ""),
        ),
      )
      .toBe(true);
  });

  it("classifies a dead login from stderr when there is no result line", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-fake-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = path.join(tmp, "fake-claude.sh");
    await fs.writeFile(
      bin,
      ['#!/bin/sh', "cat > /dev/null", 'echo "OAuth token has expired. Please run /login" >&2', "exit 1"].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);
    const run = await mgr.start({ prompt: "anything" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("failed");
    expect(settled.failure?.kind).toBe("auth");
  });

  it("does not classify ordinary failures", async () => {
    const mgr = await makeManager(
      [
        INIT_LINE,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"TypeError: boom","session_id":"sess_fake","num_turns":1,"duration_ms":5}',
      ],
      1,
    );
    const run = await mgr.start({ prompt: "task" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.failure).toBeFalsy();
  });

  it("messageRun resumes a settled session with the framed user message", async () => {
    const mgr = await makeManager(
      [
        INIT_LINE,
        '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}',
      ],
      0,
    );
    const run = await mgr.start({ prompt: "Base task" });
    await mgr.waitForSettled(run.id);

    const delivery = await mgr.messageRun(run.id, "Focus on the edge cases.");
    expect(delivery.status).toBe("resumed");
    expect(delivery.run?.resumedFromRunId).toBe(run.id);
    expect(delivery.run?.prompt).toContain("USER MESSAGE:");
    expect(delivery.run?.prompt).toContain("Focus on the edge cases.");
    await mgr.waitForSettled(delivery.run!.id);
  });

  it("messageRun records-only for a cancelled chain", async () => {
    const mgr = await makeManager(
      [
        INIT_LINE,
        '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}',
      ],
      0,
    );
    const run = await mgr.start({ prompt: "Doomed task" });
    await mgr.waitForSettled(run.id);
    // Simulate a user kill on the latest turn (list() hands back live records).
    (await mgr.list()).find((r) => r.id === run.id)!.status = "cancelled";
    const delivery = await mgr.messageRun(run.id, "hello?");
    expect(delivery.status).toBe("recorded");
    expect(delivery.run).toBeNull();
  });

  it("auth failures raise the instance flag, park deliveries, and a success flushes them", async () => {
    // Fake CLI whose behavior is switched by rewriting the script between runs.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-fake-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = path.join(tmp, "fake-claude.sh");
    const okScript = [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo '${INIT_LINE}'`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}'`,
      "exit 0",
    ].join("\n");
    const authFailScript = [
      "#!/bin/sh",
      "cat > /dev/null",
      'echo "OAuth token has expired. Please run /login" >&2',
      "exit 1",
    ].join("\n");
    await fs.writeFile(bin, okScript, { mode: 0o755 });
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);

    // A healthy run establishes a resumable session.
    const base = await mgr.start({ prompt: "Base task" });
    await mgr.waitForSettled(base.id);
    expect(mgr.authState().broken).toBe(false);

    // Break the login: the next run fails with an auth classification.
    await fs.writeFile(bin, authFailScript, { mode: 0o755 });
    const broken = await mgr.start({ prompt: "Doomed" });
    await mgr.waitForSettled(broken.id);
    expect(mgr.authState().broken).toBe(true);

    // Deliveries park instead of burning failed resume runs.
    const parked = await mgr.messageRun(base.id, "are you there?");
    expect(parked.status).toBe("queued");
    const runCountWhileParked = (await mgr.list()).length;

    // Heal the login: a successful run clears the flag and flushes the queue.
    await fs.writeFile(bin, okScript, { mode: 0o755 });
    const healer = await mgr.start({ prompt: "Healthy again" });
    await mgr.waitForSettled(healer.id);
    // The clear runs in finish() on process close — a tick after the result
    // event settles the run — so poll rather than assert immediately.
    await expect.poll(() => mgr.authState().broken).toBe(false);
    await expect
      .poll(async () =>
        (await mgr.list()).some(
          (r) => r.resumedFromRunId === base.id && r.prompt.includes("are you there?"),
        ),
      )
      .toBe(true);
    expect((await mgr.list()).length).toBeGreaterThan(runCountWhileParked);
  });

  it("refuses to resume a session whose run is still live (fork guard)", { timeout: 15_000 }, async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-fake-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = path.join(tmp, "fake-claude.sh");
    // Emits init (so the session id is known), then stays alive for a while.
    await fs.writeFile(
      bin,
      ["#!/bin/sh", "cat > /dev/null", `echo '${INIT_LINE}'`, "sleep 5"].join("\n"),
      { mode: 0o755 },
    );
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);
    const live = await mgr.start({ prompt: "long-lived" });
    await expect.poll(async () => (await mgr.get(live.id))?.sessionId).toBe("sess_fake");

    await expect(
      mgr.start({ prompt: "fork attempt", resumeSessionId: "sess_fake" }),
    ).rejects.toThrow(/fork/);

    // Back-to-back resumes are also guarded: a resumed run carries its session
    // id from creation, before any init event arrives.
    await mgr.cancel(live.id);
    await mgr.waitForSettled(live.id);
    const resumed = await mgr.start({ prompt: "turn 2", resumeSessionId: "sess_fake" });
    expect(resumed.sessionId).toBe("sess_fake");
    await expect(
      mgr.start({ prompt: "another fork attempt", resumeSessionId: "sess_fake" }),
    ).rejects.toThrow(/fork/);
    await mgr.cancel(resumed.id);
    await mgr.waitForSettled(resumed.id);
  });

  it("hands off to a fresh session: summarizer runs, continuation carries the note", async () => {
    // Every spawn (the failed run, the summarizer, the continuation) uses the
    // same fake CLI, which succeeds with a canned result text.
    const mgr = await makeManager(
      [
        INIT_LINE,
        '{"type":"result","subtype":"success","is_error":false,"result":"SUMMARY NOTE: did X, remains Y","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}',
      ],
      0,
    );
    const original = await mgr.start({ prompt: "Build the parser", tags: ["t:1"] });
    await mgr.waitForSettled(original.id);

    const continuation = await mgr.handoff(original.id);
    expect(continuation.handoffFromRunId).toBe(original.id);
    expect(continuation.prompt).toContain("Build the parser");
    expect(continuation.prompt).toContain("SUMMARY NOTE");
    expect(continuation.resumedFromRunId).toBeFalsy(); // fresh chain, not a resume
    await mgr.waitForSettled(continuation.id);

    // Lineage is visible in the run list: original ← summarizer + continuation.
    const runs = await mgr.list();
    expect(runs.some((r) => r.purpose === "manage")).toBe(true); // the summarizer
  });
});

// A fake Claude CLI that behaves like a git-aware agent: if the worktree has
// conflict markers it resolves and completes the merge; otherwise it creates a
// feature file and commits. Enough to drive the merge-back orchestration.
async function writeGitAwareClaude(dir: string): Promise<string> {
  const bin = path.join(dir, "git-claude.sh");
  const initLine =
    '{"type":"system","subtype":"init","session_id":"sess_fake","model":"m","cwd":".","tools":[]}';
  const resultLine =
    '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}';
  await fs.writeFile(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      'CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null)',
      'if [ -n "$CONFLICTED" ]; then',
      "  for f in $CONFLICTED; do",
      "    printf 'resolved: both sides\\n' > \"$f\"",
      '    git add "$f"',
      "  done",
      "  git -c user.name=Resolver -c user.email=r@local commit --no-edit --no-verify >/dev/null 2>&1",
      "else",
      "  printf 'worktree version\\n' > feature.txt",
      "  git add feature.txt",
      "  git -c user.name=Worker -c user.email=w@local commit -m 'add feature' --no-verify >/dev/null 2>&1",
      "fi",
      `echo '${initLine}'`,
      `echo '${resultLine}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

async function gitIn(cwd: string, ...args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}

describe.skipIf(process.platform === "win32")("worktree merge orchestration", () => {
  let tmp: string;

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("resolves conflicts in the run's worktree and lands the result on main", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-merge-orch-"));
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    await gitIn(root, "init", "-b", "main");
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await gitIn(root, "add", "-A");
    await gitIn(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-m", "base");

    const bin = await writeGitAwareClaude(tmp);
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);

    // 1. Worktree run: the fake creates feature.txt and commits in its worktree.
    const run = await mgr.start({ prompt: "Add the feature", isolation: "worktree" });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("completed");
    expect(settled.worktreePath).toBeTruthy();

    // 2. A conflicting change on main: same new file, different content.
    await fs.writeFile(path.join(root, "feature.txt"), "main version\n");
    await gitIn(root, "add", "-A");
    await gitIn(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-m", "main feature");

    // 3. Preview must predict the conflict (git ≥ 2.40 for the file list).
    const preview = await mgr.mergePreview(run.id);
    expect(preview.target).toBe("main");
    if (!preview.predictionUnavailable) {
      expect(preview.conflicts).toContain("feature.txt");
      expect(preview.canMerge).toBe(false);
    }

    // 4. Resolve: spawns a resolver run IN THE SAME worktree (worktreeOfRunId).
    const { run: resolver, conflicts } = await mgr.resolveConflicts(run.id);
    expect(conflicts).toContain("feature.txt");
    expect(resolver.worktreePath).toBe(settled.worktreePath); // adopted, not fresh
    const resolved = await mgr.waitForSettled(resolver.id);
    expect(resolved.status).toBe("completed");

    // 5. Land it — now a fast-forward — onto main's checkout.
    const result = await mgr.mergeWorktreeOf(run.id, {});
    expect(result.target).toBe("main");
    const landed = await fs.readFile(path.join(root, "feature.txt"), "utf8");
    expect(landed).toContain("resolved: both sides");
  });

  it("refuses merge/resolve while a live run shares the worktree", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-merge-orch-"));
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    await gitIn(root, "init", "-b", "main");
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await gitIn(root, "add", "-A");
    await gitIn(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-m", "base");

    // A fake that stays alive so the run holds its worktree.
    const bin = path.join(tmp, "slow.sh");
    await fs.writeFile(
      bin,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `echo '{"type":"system","subtype":"init","session_id":"s","model":"m","cwd":".","tools":[]}'`,
        "sleep 5",
      ].join("\n"),
      { mode: 0o755 },
    );
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);
    const run = await mgr.start({ prompt: "long", isolation: "worktree" });
    await expect
      .poll(async () => (await mgr.get(run.id))?.worktreePath)
      .toBeTruthy();

    await expect(mgr.mergeWorktreeOf(run.id, {})).rejects.toThrow(/in use by live run/i);
    await expect(mgr.resolveConflicts(run.id)).rejects.toThrow(/in use by live run/i);

    await mgr.cancel(run.id);
    await mgr.waitForSettled(run.id);
  });
});
