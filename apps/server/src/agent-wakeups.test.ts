import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun } from "@crystal/core";
import { AgentManager } from "./agent-manager.js";

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
