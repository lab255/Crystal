import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun } from "@crystal/core";
import { AgentManager } from "./agent-manager.js";

const exec = promisify(execFile);

/**
 * The wake-up loop, end-to-end against a stand-in CLI.
 *
 * This is the mechanism the whole orchestration stack rests on: a manager ends
 * its turn after dispatching, and is *resumed* when something it is waiting on
 * happens — a worker settling, or a message delivered while it was busy. Both
 * halves have been silently broken before (notices stringified as
 * `[object Object]`; a message queued on a worker's own chain that nothing
 * ever flushed), so it is worth exercising for real rather than through a fake
 * AgentManager.
 */

/** A stand-in for the Claude CLI: emits the stream-json lines the parser expects. */
async function writeFakeClaude(dir: string, delayMs: number): Promise<string> {
  const script = path.join(dir, "fake-claude.mjs");
  await fs.writeFile(
    script,
    `
const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const session = resumeAt >= 0 ? args[resumeAt + 1] : "sess-" + process.pid;
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: session, model: "fake", tools: [] });
await new Promise((r) => setTimeout(r, ${delayMs}));
emit({ type: "assistant", message: { content: [{ type: "text", text: prompt.slice(0, 200) }] } });
emit({
  type: "result", subtype: "success", is_error: false, result: "ok",
  session_id: session, total_cost_usd: 0, num_turns: 1, duration_ms: ${delayMs},
});
`,
    "utf8",
  );
  if (process.platform === "win32") {
    const cmd = path.join(dir, "fake-claude.cmd");
    await fs.writeFile(cmd, `@echo off\r\nnode "${script}" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, "fake-claude.sh");
  await fs.writeFile(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, "utf8");
  await fs.chmod(sh, 0o755);
  return sh;
}

/** Resolve once `predicate` holds, or throw after `timeoutMs`. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the wake-up");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("agent wake-ups", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    // The fake CLI may still be exiting; a locked temp dir must not fail the
    // test that already passed.
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  async function makeManager(delayMs = 400): Promise<AgentManager> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-wakeup-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    return new AgentManager(root, path.join(tmp, "data"), await writeFakeClaude(tmp, delayMs));
  }

  it("resumes a manager with its worker's result, in readable text", async () => {
    const mgr = await makeManager(150);
    const runs: AgentRun[] = [];
    mgr.events.on("runChanged", ({ run }) => {
      if (!runs.some((r) => r.id === run.id)) runs.push(run);
    });

    const manager = await mgr.start({ prompt: "coordinate", role: "manager" });
    await mgr.waitForSettled(manager.id);
    const worker = await mgr.dispatchWorker(manager.id, { prompt: "do the thing" });
    expect(worker).not.toBeNull();
    await mgr.waitForSettled(worker!.id);

    // The manager is resumed on the same session, carrying the worker's result.
    await until(async () => (await mgr.chainRuns(manager.id)).length > 1);
    const woken = (await mgr.chainRuns(manager.id)).at(-1)!;
    expect(woken.id).not.toBe(manager.id);
    expect(woken.prompt).toContain(`Worker ${worker!.id} settled: completed`);
    // The worker's *result* rides along — that is the point of the wake-up.
    expect(woken.prompt).toContain("ok");
    // Regression: the notices were once joined as objects.
    expect(woken.prompt).not.toContain("[object Object]");
    expect(woken.prompt).toContain("do not busy-poll worker_status");
  });

  it("delivers a message queued while the chain was mid-turn", async () => {
    const mgr = await makeManager(600);
    const manager = await mgr.start({ prompt: "coordinate", role: "manager" });

    // Mid-turn: a bare resume would fork the session, so this queues.
    const immediate = await mgr.deliver(manager.id, "OWNER MESSAGE: change of plan.");
    expect(immediate).toBeNull();

    await mgr.waitForSettled(manager.id);
    await until(async () => (await mgr.chainRuns(manager.id)).length > 1);
    const chain = await mgr.chainRuns(manager.id);
    expect(chain).toHaveLength(2);
    // Delivered verbatim — and *not* dressed up as a worker settlement.
    expect(chain[1]!.prompt).toBe("OWNER MESSAGE: change of plan.");
  });

  it("types a worker's result into a live interactive manager terminal", async () => {
    // Regression: an interactive manager's chain is live for its whole TUI
    // session, so the settle-time gate held every worker notice until the
    // terminal closed — while the manager's prompt promises settlements are
    // typed in as they happen.
    const mgr = await makeManager(150);
    mgr.interactiveReadyMs = 0;
    const typed: string[] = [];
    mgr.interactiveInput = (_run, text) => {
      typed.push(text);
      return true;
    };
    const plan = await mgr.prepareInteractive({ prompt: "coordinate", role: "manager" });
    const manager = await mgr.bindInteractive(plan.run.id, "term_mgr");
    const worker = (await mgr.dispatchWorker(manager.id, { prompt: "do the thing" }))!;
    expect(worker).not.toBeNull();
    await mgr.waitForSettled(worker.id);

    await until(() => typed.length > 0);
    expect(typed[0]).toContain(`Worker ${worker.id} settled: completed`);
    // Typed into the TUI, never a --resume of the live chain (that would fork).
    expect(await mgr.chainRuns(manager.id)).toHaveLength(1);
  });

  it("resumes an isolated chain in its own worktree, not the plain repo", async () => {
    // Regression: a resumed turn ran in the repo checkout while the session's
    // earlier edits lived in its worktree — steering an isolated agent
    // silently stranded its work.
    const mgr = await makeManager(150);
    const root = path.join(tmp!, "root");
    await exec("git", ["init"], { cwd: root });
    await exec(
      "git",
      ["-c", "user.email=t@crystal.test", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      { cwd: root },
    );

    const run = await mgr.start({ prompt: "isolated work", isolation: "worktree" });
    expect(run.worktreePath).toBeTruthy();
    await mgr.waitForSettled(run.id);

    const resumed = await mgr.deliver(run.id, "follow-up: keep going.");
    expect(resumed).not.toBeNull();
    expect(resumed!.resumedFromRunId).toBe(run.id);
    // Same working copy, and the record says so (diff/apply keep working).
    expect(resumed!.worktreePath).toBe(run.worktreePath);
    await mgr.waitForSettled(resumed!.id);
  });

  it("two chains sharing a track worktree never both resume into it", async () => {
    // Regression: the adoption check ran outside the branch lock, so two
    // concurrent delivers (or a deliver racing a fresh dispatch) both passed
    // the live-holder scan before either registered its run — two live Claude
    // processes editing one working copy.
    const mgr = await makeManager(600);
    const root = path.join(tmp!, "root");
    await exec("git", ["init"], { cwd: root });
    await exec(
      "git",
      ["-c", "user.email=t@crystal.test", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      { cwd: root },
    );

    const first = await mgr.start({ prompt: "track work", isolation: "worktree", branch: "track/x" });
    await mgr.waitForSettled(first.id);
    // Second chain adopts the same track worktree (branch = identity).
    const second = await mgr.start({ prompt: "more track work", isolation: "worktree", branch: "track/x" });
    await mgr.waitForSettled(second.id);
    expect(second.worktreePath).toBe(first.worktreePath);

    const [r1, r2] = await Promise.all([
      mgr.deliver(first.id, "continue A"),
      mgr.deliver(second.id, "continue B"),
    ]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // Exactly one adopted the shared worktree; the loser fell back visibly.
    const adopters = [r1!, r2!].filter((r) => r.worktreePath === first.worktreePath);
    expect(adopters).toHaveLength(1);
    await mgr.waitForSettled(r1!.id);
    await mgr.waitForSettled(r2!.id);
  });

  it("grants bypassPermissions only with workspace consent", async () => {
    const mgr = await makeManager(50);
    // Default-deny: no resolver wired (or a false one) downgrades the run.
    const denied = await mgr.prepareInteractive({
      prompt: "x",
      permissionMode: "bypassPermissions",
    });
    expect(denied.args[denied.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");

    mgr.bypassResolver = async () => true;
    const granted = await mgr.prepareInteractive({
      prompt: "x",
      permissionMode: "bypassPermissions",
    });
    expect(granted.args[granted.args.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
  });

  it("applies the workspace default permission mode, still behind the bypass gate", async () => {
    const mgr = await makeManager(50);
    mgr.defaultModeResolver = async () => "bypassPermissions";
    // The roster default asks for bypass, but consent is off — downgraded.
    const denied = await mgr.prepareInteractive({ prompt: "x" });
    expect(denied.args[denied.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");

    mgr.bypassResolver = async () => true;
    const granted = await mgr.prepareInteractive({ prompt: "x" });
    expect(granted.args[granted.args.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );

    // An explicit mode on the dispatch always wins over the workspace default.
    const explicit = await mgr.prepareInteractive({ prompt: "x", permissionMode: "plan" });
    expect(explicit.args[explicit.args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("delivers a message queued on a worker's own chain when the worker settles", async () => {
    // Regression: a worker's settlement only ever flushed its *manager's*
    // queue, so an answer to a question the worker asked was lost forever.
    const mgr = await makeManager(600);
    const manager = await mgr.start({ prompt: "coordinate", role: "manager" });
    await mgr.waitForSettled(manager.id);
    const worker = (await mgr.dispatchWorker(manager.id, { prompt: "ask something" }))!;

    const queued = await mgr.deliver(worker.id, 'Answer to your question: "yes".');
    expect(queued).toBeNull();

    await mgr.waitForSettled(worker.id);
    await until(async () => (await mgr.chainRuns(worker.id)).length > 1);
    const chain = await mgr.chainRuns(worker.id);
    expect(chain.map((r) => r.prompt)).toContain('Answer to your question: "yes".');
  });
});

describe("per-run cost cap", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  /** A CLI stand-in that streams an expensive usage line, then stalls. */
  async function writeSpendyClaude(dir: string): Promise<string> {
    const script = path.join(dir, "spendy-claude.mjs");
    await fs.writeFile(
      script,
      `
process.stdin.resume();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-spendy", model: "fake", tools: [] });
emit({
  type: "assistant",
  message: {
    usage: { input_tokens: 10_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: "burning tokens" }],
  },
});
// Stall: without the cap kill this process would sit here for 30s.
await new Promise((r) => setTimeout(r, 30_000));
emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-spendy", total_cost_usd: 30, num_turns: 1, duration_ms: 1 });
`,
      "utf8",
    );
    if (process.platform === "win32") {
      const cmd = path.join(dir, "spendy-claude.cmd");
      await fs.writeFile(cmd, `@echo off\r\nnode "${script}" %*\r\n`, "utf8");
      return cmd;
    }
    const sh = path.join(dir, "spendy-claude.sh");
    await fs.writeFile(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, "utf8");
    await fs.chmod(sh, 0o755);
    return sh;
  }

  it("kills a run whose streamed usage crosses its cap, with the reason on the record", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-costcap-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = await writeSpendyClaude(tmp);
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);

    // 10M input tokens at fallback pricing is dollars; the cap is cents.
    const run = await mgr.start({ prompt: "spend a lot", costCapUsd: 0.05 });
    const settled = await mgr.waitForSettled(run.id);
    expect(settled.status).toBe("cancelled");
    expect(settled.resultText).toContain("Run cost cap hit");
    expect(settled.resultText).toContain("$0.05");
  }, 20_000);

  it("an uncapped run with the same usage is left alone", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-costcap-off-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root, { recursive: true });
    const bin = await writeSpendyClaude(tmp);
    const mgr = new AgentManager(root, path.join(tmp, "data"), bin);

    const run = await mgr.start({ prompt: "spend a lot" });
    // Give the usage line time to stream — the run must still be live.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await mgr.get(run.id))?.status).toBe("running");
    await mgr.cancel(run.id);
    await mgr.waitForSettled(run.id);
  }, 20_000);
});
