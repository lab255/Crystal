import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStandingTask, standingTag } from "@crystal/core";
import { AgentManager } from "./agent-manager.js";
import { StandingTaskEngine } from "./standing-tasks.js";
import { WorkspaceStore } from "./workspace-store.js";

let tmp: string;
let root: string;
let agents: AgentManager;
let engine: StandingTaskEngine;

const INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"sess_fake","model":"fake","cwd":".","tools":[]}';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-standing-"));
  root = path.join(tmp, "root");
  await fs.mkdir(root, { recursive: true });
  const bin = path.join(tmp, "fake-claude.sh");
  await fs.writeFile(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo '${INIT_LINE}'`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"swept","session_id":"sess_fake","total_cost_usd":0.01,"num_turns":1,"duration_ms":5}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const store = new WorkspaceStore(root);
  agents = new AgentManager(root, path.join(tmp, "data"), bin);
  engine = new StandingTaskEngine(path.join(tmp, "data"), agents, store);
});

afterEach(async () => {
  engine.dispose();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(process.platform === "win32")("StandingTaskEngine", () => {
  it("persists definitions, fires a due task once, and records the fire", async () => {
    const task = createStandingTask({
      name: "triage",
      instructions: "Sweep the TODOs.",
      schedule: { kind: "every", minutes: 30 },
    });
    await engine.saveDefs({ tasks: [task] });

    // Never fired → due now; fireNow stands in for the sweeper tick.
    const fire = await engine.fireNow(task.id);
    expect(fire.runId).toBeTruthy();
    const run = (await agents.list()).find((r) => r.id === fire.runId)!;
    expect(run.tags).toContain(standingTag(task.id));
    expect(run.prompt).toContain("Sweep the TODOs.");
    expect(run.prompt).toContain("FRESH session");
    await agents.waitForSettled(run.id);

    const [info] = await engine.list();
    expect(info!.lastFiredAt).toBeTruthy();
    // Next fire is ~30m out — not due again.
    expect(Date.parse(info!.nextFireAt!)).toBeGreaterThan(Date.now() + 20 * 60_000);
  });

  it("suppresses a fire while the previous one is still live", async () => {
    const slowBin = path.join(tmp, "slow-claude.sh");
    await fs.writeFile(
      slowBin,
      ["#!/bin/sh", "cat > /dev/null", `echo '${INIT_LINE}'`, "sleep 4"].join("\n"),
      { mode: 0o755 },
    );
    const store = new WorkspaceStore(root);
    const slowAgents = new AgentManager(root, path.join(tmp, "data2"), slowBin);
    const slowEngine = new StandingTaskEngine(path.join(tmp, "data2"), slowAgents, store);
    const task = createStandingTask({
      name: "slow",
      instructions: "Take a while.",
      schedule: { kind: "every", minutes: 5 },
    });
    await slowEngine.saveDefs({ tasks: [task] });
    const first = await slowEngine.fireNow(task.id);
    expect(first.runId).toBeTruthy();
    const second = await slowEngine.fireNow(task.id);
    expect(second.runId).toBeNull();
    expect(second.reason).toMatch(/still running/i);
    const [info] = await slowEngine.list();
    expect(info!.liveRunId).toBe(first.runId);
    await slowAgents.cancel(first.runId!);
    await slowAgents.waitForSettled(first.runId!);
    slowEngine.dispose();
  });

  it("remembers lastFiredAt across engine restarts (no boot re-fire)", async () => {
    const task = createStandingTask({
      name: "durable",
      instructions: "Do the thing.",
      schedule: { kind: "every", minutes: 60 },
    });
    await engine.saveDefs({ tasks: [task] });
    const fire = await engine.fireNow(task.id);
    await agents.waitForSettled(fire.runId!);

    const reborn = new StandingTaskEngine(path.join(tmp, "data"), agents, new WorkspaceStore(root));
    const [info] = await reborn.list();
    expect(info!.lastFiredAt).toBeTruthy();
    expect(Date.parse(info!.nextFireAt!)).toBeGreaterThan(Date.now());
    reborn.dispose();
  });

  it("trust gate: a due task loaded from the repo file does not fire on open", async () => {
    // Simulate a hostile repo: write a task that would be due immediately
    // straight into `.crystal/standing-tasks.json`, then open a fresh engine
    // and let its opening sweep run — it must NOT fire (no auto-exec on open).
    const store = new WorkspaceStore(root);
    const task = createStandingTask({
      name: "auto-exec",
      instructions: "node -e 'malicious()'",
      schedule: { kind: "every", minutes: 5 }, // never-fired interval = otherwise due now
    });
    await store.saveStandingTasks({ tasks: [task] });

    const fresh = new StandingTaskEngine(path.join(tmp, "gate-data"), agents, store);
    fresh.start(); // runs the opening sweep immediately
    await new Promise((r) => setTimeout(r, 400));
    expect((await agents.list()).some((r) => r.tags.includes(standingTag(task.id)))).toBe(false);
    const [info] = await fresh.list();
    expect(info!.lastFiredAt).toBeNull(); // the floor is not shown as a fire
    // First fire is a genuine FUTURE slot, never a retroactive on-open one.
    expect(Date.parse(info!.nextFireAt!)).toBeGreaterThan(Date.now());

    // The explicit "fire now" button (a user action) still works immediately.
    const fired = await fresh.fireNow(task.id);
    expect(fired.runId).toBeTruthy();
    await agents.waitForSettled(fired.runId!);
    fresh.dispose();
  });

  it("two concurrent fires of one task spawn exactly one run", async () => {
    const task = createStandingTask({
      name: "racy",
      instructions: "x",
      schedule: { kind: "every", minutes: 30 },
    });
    await engine.saveDefs({ tasks: [task] });
    // Fire twice without awaiting between — the in-flight claim must let only
    // one through (the other reports the previous fire is running).
    const [a, b] = await Promise.all([engine.fireNow(task.id), engine.fireNow(task.id)]);
    const started = [a, b].filter((r) => r.runId);
    expect(started).toHaveLength(1);
    const suppressed = [a, b].find((r) => !r.runId);
    expect(suppressed!.reason).toMatch(/still running/i);
    const tagged = (await agents.list()).filter((r) => r.tags.includes(standingTag(task.id)));
    expect(tagged).toHaveLength(1);
    await agents.waitForSettled(started[0]!.runId!);
  });

  it("disabled tasks report no next fire", async () => {
    const task = createStandingTask({
      name: "off",
      instructions: "x",
      schedule: { kind: "daily", hour: 3, minute: 0 },
    });
    await engine.saveDefs({ tasks: [{ ...task, enabled: false }] });
    const [info] = await engine.list();
    expect(info!.nextFireAt).toBeNull();
  });
});
