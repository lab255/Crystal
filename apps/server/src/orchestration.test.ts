import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentRun, type AgentRun, type Project } from "@crystal/core";
import type { AgentManager } from "./agent-manager.js";
import { OrchestrationService } from "./orchestration.js";
import { WorkspaceStore } from "./workspace-store.js";

/** Records what was delivered back to an asking run, and to which run. */
const delivered: { runId: string; prompt: string }[] = [];
/** What `deliver` should hand back — null stands in for "queued, not resumed". */
let deliverResult: AgentRun | null = null;
/** Chain membership for updateTaskAsRun (run id → the runs of its chain). */
const chainsByRun = new Map<string, AgentRun[]>();

function fakeAgents(runs: AgentRun[]): AgentManager {
  return {
    list: async () => runs,
    chainRuns: async (runId: string) =>
      chainsByRun.get(runId) ?? runs.filter((r) => r.id === runId),
    deliver: async (runId: string, prompt: string) => {
      delivered.push({ runId, prompt });
      return deliverResult;
    },
  } as unknown as AgentManager;
}

describe("OrchestrationService", () => {
  let root: string;
  let store: WorkspaceStore;
  let projectPath: string;
  const runs: AgentRun[] = [];
  let changed = 0;
  let svc: OrchestrationService;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-orch-"));
    store = new WorkspaceStore(root);
    const info = await store.load(); // seeds the "General" project
    projectPath = info.projects[0]!.path;
    svc = new OrchestrationService(store, fakeAgents(runs), () => {
      changed += 1;
    });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function loadProject(): Promise<Project> {
    const info = await store.load();
    return info.projects.find((p) => p.path === projectPath)!.project;
  }

  it("creates epics and tasks, filtering unknown blockers", async () => {
    const epic = await svc.createEpicOn(projectPath, "Ship v1", "Everything for launch");
    const a = await svc.createTask(projectPath, { title: "Task A", epicId: epic.id, priority: "high" });
    const b = await svc.createTask(projectPath, {
      title: "Task B",
      epicId: epic.id,
      blockedBy: [a.id, "task_nonexistent"],
    });
    expect(b.blockedBy).toEqual([a.id]);
    const project = await loadProject();
    expect(project.epics.map((e) => e.name)).toContain("Ship v1");
    expect(project.tasks).toHaveLength(2);
    expect(changed).toBeGreaterThan(0);
  });

  it("enforces one writer per task", async () => {
    const project = await loadProject();
    const task = project.tasks.find((t) => t.title === "Task A")!;

    // Unclaimed write is rejected.
    const unclaimed = await svc.updateTask(projectPath, task.id, { status: "in_progress" }, {});
    expect(unclaimed.ok).toBe(false);

    // Claim, then write with the claim id.
    const claim = await svc.claimTask(projectPath, task.id, { holder: "agent-a", holderRunId: "run_1" });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("unreachable");
    const write = await svc.updateTask(
      projectPath,
      task.id,
      { status: "in_progress" },
      { claimId: claim.lease.claimId },
    );
    expect(write.ok).toBe(true);

    // A second writer can neither claim nor write while the lease is valid.
    const rival = await svc.claimTask(projectPath, task.id, { holder: "agent-b" });
    expect(rival.ok).toBe(false);
    const rivalWrite = await svc.updateTask(projectPath, task.id, { status: "done" }, { claimId: "claim_bogus" });
    expect(rivalWrite.ok).toBe(false);

    // The human owner's force bypasses; release then frees the task.
    const forced = await svc.updateTask(projectPath, task.id, { priority: "urgent" }, { force: true });
    expect(forced.ok).toBe(true);
    const release = await svc.releaseTask(projectPath, task.id, { claimId: claim.lease.claimId });
    expect(release.ok).toBe(true);
    expect((await loadProject()).tasks.find((t) => t.id === task.id)!.lease).toBeNull();
  });

  it("preserves server-owned columns across whole-project saves", async () => {
    const project = await loadProject();
    const task = project.tasks.find((t) => t.title === "Task B")!;
    const claim = await svc.claimTask(projectPath, task.id, { holder: "agent-c" });
    expect(claim.ok).toBe(true);

    // A stale client snapshot (no lease on the task) saves the whole project.
    const stale = structuredClone(await loadProject());
    for (const t of stale.tasks) {
      t.lease = null;
      t.cost = { totalTokens: 999, costUsd: 999, runCount: 9, byModel: {}, updatedAt: "x" };
    }
    stale.name = "Renamed";
    await svc.saveProjectGuarded(projectPath, stale);

    const after = await loadProject();
    expect(after.name).toBe("Renamed"); // client-owned field applied
    const afterTask = after.tasks.find((t) => t.id === task.id)!;
    expect(afterTask.lease?.holder).toBe("agent-c"); // lease survived
    expect(afterTask.cost).toBeNull(); // fabricated cost discarded
  });

  it("settles runs: bills the task and epic, releases the run's lease", async () => {
    const project = await loadProject();
    const epic = project.epics[0]!;
    const task = project.tasks.find((t) => t.title === "Task A")!;

    const claim = await svc.claimTask(projectPath, task.id, {
      holder: "agent-a",
      holderRunId: "run_settle",
      claimId: undefined,
    });
    expect(claim.ok).toBe(true);
    // Make the lease belong to the settling run.
    if (claim.ok) {
      const write = await svc.updateTask(projectPath, task.id, {}, { claimId: claim.lease.claimId });
      expect(write.ok).toBe(true);
    }

    const run = createAgentRun({ prompt: "implement Task A", taskId: task.id, projectId: project.id });
    run.id = "run_settle";
    run.model = "claude-haiku-4-5";
    run.status = "completed";
    run.usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 2 };
    run.costUsd = 0.05;
    runs.push(run);

    await svc.settleRun(run);
    const after = await loadProject();
    const settled = after.tasks.find((t) => t.id === task.id)!;
    expect(settled.cost?.costUsd).toBeCloseTo(0.05, 5);
    expect(settled.cost?.totalTokens).toBe(1500);
    expect(settled.cost?.byModel["claude-haiku-4-5"]).toBeDefined();
    expect(settled.runIds).toContain("run_settle");
    expect(settled.lease).toBeNull(); // the run's lease healed on settle
    const settledEpic = after.epics.find((e) => e.id === epic.id)!;
    expect(settledEpic.cost?.costUsd).toBeCloseTo(0.05, 5);
  });

  it("renders a board snapshot with descriptions, without leaking claim ids", async () => {
    await svc.createTask(projectPath, {
      title: "Task C",
      description: "Acceptance: parser round-trips every fixture.",
    });
    const snapshot = await svc.snapshot(projectPath);
    expect(snapshot).toContain("Task A");
    expect(snapshot).toContain("Ship v1");
    expect(snapshot).toContain("parser round-trips");
    expect(snapshot).not.toContain("claim_");
  });

  it("bumps the save rev on every write and merges stale whole-project saves", async () => {
    const before = await loadProject();
    const stale = structuredClone(before);
    // An agent write lands after the client snapshot…
    const agentTask = await svc.createTask(projectPath, { title: "agent made" });
    // …then the stale snapshot saves (it does not contain agentTask).
    stale.name = "Merged";
    await svc.saveProjectGuarded(projectPath, stale);
    const after = await loadProject();
    expect(after.name).toBe("Merged");
    expect(after.tasks.some((t) => t.id === agentTask.id)).toBe(true); // survived the stale save
    expect(after.rev).toBeGreaterThan(before.rev);
  });

  it("worker runs write their own task by run identity, auto-claiming the lease", async () => {
    const task = await svc.createTask(projectPath, { title: "worker task" });
    const write = await svc.updateTaskAsRun(
      projectPath,
      task.id,
      { id: "run_worker", holder: "impl-agent" },
      { status: "in_progress" },
    );
    expect(write.ok).toBe(true);
    const leased = (await loadProject()).tasks.find((t) => t.id === task.id)!;
    expect(leased.status).toBe("in_progress");
    expect(leased.lease?.holderRunId).toBe("run_worker");

    // Another run may not touch it while the worker's lease is valid.
    const rival = await svc.updateTaskAsRun(projectPath, task.id, { id: "run_other" }, { status: "done" });
    expect(rival.ok).toBe(false);

    // The same run writes again (heartbeat path keeps the claim id).
    const claimId = leased.lease!.claimId;
    const again = await svc.updateTaskAsRun(projectPath, task.id, { id: "run_worker" }, { status: "review" });
    expect(again.ok).toBe(true);
    expect((await loadProject()).tasks.find((t) => t.id === task.id)!.lease?.claimId).toBe(claimId);
  });

  it("transfers a manager's lease to the dispatched worker; settlement releases it", async () => {
    const project = await loadProject();
    const task = await svc.createTask(projectPath, { title: "handover" });
    const claim = await svc.claimTask(projectPath, task.id, {
      holder: "manager",
      holderRunId: "run_mgr",
    });
    expect(claim.ok).toBe(true);

    const worker = createAgentRun({
      prompt: "do it",
      taskId: task.id,
      projectId: project.id,
      parentRunId: "run_mgr",
    });
    await svc.transferLeaseToRun(worker);
    const leased = (await loadProject()).tasks.find((t) => t.id === task.id)!;
    expect(leased.lease?.holderRunId).toBe(worker.id);
    if (!claim.ok) throw new Error("unreachable");
    expect(leased.lease?.claimId).toBe(claim.lease.claimId); // capability moved, not reminted

    worker.status = "completed";
    runs.push(worker);
    await svc.settleRun(worker);
    expect((await loadProject()).tasks.find((t) => t.id === task.id)!.lease).toBeNull();
  });

  it("files questions on tasks, deduped per run and text", async () => {
    const task = await svc.createTask(projectPath, { title: "curious" });
    await svc.addQuestion(projectPath, task.id, "Which schema?", "run_q");
    await svc.addQuestion(projectPath, task.id, "Which schema?", "run_q"); // duplicate
    const saved = (await loadProject()).tasks.find((t) => t.id === task.id)!;
    expect(saved.questions).toHaveLength(1);
    expect(saved.questions[0]!.text).toBe("Which schema?");
    const missing = await svc.addQuestion(projectPath, "task_nope", "?", null);
    expect(missing.ok).toBe(false);
  });

  it("stores structured questions and drops recommendations not in the options", async () => {
    const task = await svc.createTask(projectPath, { title: "structured" });
    await svc.addQuestion(projectPath, task.id, "Which store?", "run_s", {
      options: ["postgres", "sqlite"],
      recommended: "sqlite",
    });
    await svc.addQuestion(projectPath, task.id, "Which cache?", "run_s", {
      options: ["redis"],
      recommended: "memcached", // not offered — must be dropped
    });
    const saved = (await loadProject()).tasks.find((t) => t.id === task.id)!;
    expect(saved.questions[0]!.options).toEqual(["postgres", "sqlite"]);
    expect(saved.questions[0]!.recommended).toBe("sqlite");
    expect(saved.questions[1]!.recommended).toBeNull();
  });

  it("resolves a run's project by its task, and refuses unknown project ids", async () => {
    const project = await loadProject();
    const task = project.tasks[0]!;
    // Task wins even when the run carries no (or a wrong) projectId.
    await expect(svc.projectPathForRun({ taskId: task.id, projectId: null })).resolves.toBe(projectPath);
    await expect(svc.projectPathFor("proj_nonexistent")).rejects.toThrow(/Unknown project/);
  });

  it("answers a question: recorded once, and handed back to the asking run", async () => {
    const asker = createAgentRun({ prompt: "work" });
    runs.push(asker);
    const task = await svc.createTask(projectPath, { title: "needs a decision" });
    await svc.addQuestion(projectPath, task.id, "Version the payload?", asker.id);
    const question = (await loadProject()).tasks.find((t) => t.id === task.id)!.questions[0]!;

    const resumed = createAgentRun({ prompt: "answer", resumedFromRunId: asker.id });
    deliverResult = resumed;
    const result = await svc.answerQuestion(projectPath, task.id, question.id, "Version it.");
    expect(result).toEqual({ ok: true, resumedRunId: resumed.id });

    // Recorded on the board…
    const answered = (await loadProject()).tasks.find((t) => t.id === task.id)!.questions[0]!;
    expect(answered.answer).toBe("Version it.");
    expect(answered.answeredAt).not.toBeNull();
    // …handed to the run that asked, quoting what it asked…
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.runId).toBe(asker.id);
    expect(delivered[0]!.prompt).toContain("Version the payload?");
    expect(delivered[0]!.prompt).toContain("Version it.");
    // …and the resumed turn is linked to the task.
    expect((await loadProject()).tasks.find((t) => t.id === task.id)!.runIds).toContain(resumed.id);

    // Answering twice is refused rather than resuming the agent again.
    const again = await svc.answerQuestion(projectPath, task.id, question.id, "Again.");
    expect(again).toEqual({ ok: false, reason: expect.stringContaining("already answered") });
    expect(delivered).toHaveLength(1);
  });

  it("records an answer even when the asking run cannot be resumed", async () => {
    const task = await svc.createTask(projectPath, { title: "asked by a dead run" });
    await svc.addQuestion(projectPath, task.id, "Still there?", "run_gone");
    const question = (await loadProject()).tasks.find((t) => t.id === task.id)!.questions[0]!;

    deliverResult = null; // queued, or the chain is gone — either way, no run back
    const result = await svc.answerQuestion(projectPath, task.id, question.id, "Yes.");
    expect(result).toEqual({ ok: true, resumedRunId: null });
    // The board is the durable record; the answer is not lost.
    expect(
      (await loadProject()).tasks.find((t) => t.id === task.id)!.questions[0]!.answer,
    ).toBe("Yes.");
  });

  it("creates a task for a taskless ask and routes its answer back to the run", async () => {
    const asker = createAgentRun({ prompt: "choose the contract", purpose: "design" });
    runs.push(asker);
    const epic = await svc.createEpicOn(projectPath, "Contract decisions");

    const filed = await svc.addQuestionForRun(
      projectPath,
      asker,
      "Which payload format should we ship?",
      { options: ["JSON", "MessagePack"], recommended: "JSON" },
      { epicId: epic.id },
    );
    expect(filed).toMatchObject({ ok: true, taskCreated: true });
    if (!filed.ok) throw new Error(filed.reason);

    const created = (await loadProject()).tasks.find((task) => task.id === filed.taskId)!;
    expect(created.title).toBe("design: Which payload format should we ship?");
    expect(created.epicId).toBe(epic.id);
    expect(created.runIds).toContain(asker.id);
    expect(created.questions).toHaveLength(1);
    expect(created.questions[0]).toMatchObject({
      id: filed.questionId,
      runId: asker.id,
      options: ["JSON", "MessagePack"],
      recommended: "JSON",
    });
    expect(created.questions[0]!.answer).toBeUndefined();

    // A retry from the same taskless run reuses its task backlink and the
    // existing question rather than minting duplicate board records.
    const retried = await svc.addQuestionForRun(
      projectPath,
      asker,
      "Which payload format should we ship?",
      { options: ["JSON", "MessagePack"], recommended: "JSON" },
      { epicId: epic.id },
    );
    expect(retried).toEqual({
      ok: true,
      taskId: filed.taskId,
      questionId: filed.questionId,
      taskCreated: false,
    });

    const deliveredBefore = delivered.length;
    const resumed = createAgentRun({ prompt: "continue", resumedFromRunId: asker.id });
    deliverResult = resumed;
    await expect(
      svc.answerQuestion(projectPath, filed.taskId, filed.questionId, "JSON"),
    ).resolves.toEqual({ ok: true, resumedRunId: resumed.id });
    expect(delivered).toHaveLength(deliveredBefore + 1);
    expect(delivered.at(-1)).toMatchObject({ runId: asker.id });
    expect(delivered.at(-1)!.prompt).toContain("JSON");
  });

  it("refuses to answer an unknown task or question", async () => {
    await expect(
      svc.answerQuestion(projectPath, "task_nope", "q_1", "x"),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining("Unknown task") });
    const task = (await loadProject()).tasks[0]!;
    await expect(
      svc.answerQuestion(projectPath, task.id, "q_nope", "x"),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining("Unknown question") });
  });

  it("lets a resumed chain run update the task its predecessor leased", async () => {
    const task = await svc.createTask(projectPath, { title: "Chain lease" });
    // Run A auto-claims the task by updating it.
    const a = await svc.updateTaskAsRun(projectPath, task.id, { id: "run_a" }, { status: "in_progress" });
    expect(a.ok).toBe(true);
    // Run B is a later turn of the same logical session (chain A → B). The
    // lease pinned to A must not lock B out — that stranded workers resumed
    // with an answer, unable to move their own task to review.
    chainsByRun.set("run_b", [{ id: "run_a" }, { id: "run_b" }] as AgentRun[]);
    const b = await svc.updateTaskAsRun(projectPath, task.id, { id: "run_b" }, { status: "review" });
    expect(b.ok).toBe(true);
    const t = (await loadProject()).tasks.find((x) => x.id === task.id)!;
    expect(t.status).toBe("review");
    // The lease follows the live run, so settlement releases it correctly.
    expect(t.lease?.holderRunId).toBe("run_b");
    // A run outside the chain is still refused.
    const c = await svc.updateTaskAsRun(projectPath, task.id, { id: "run_c" }, { status: "done" });
    expect(c.ok).toBe(false);
  });

  it("resolve_question closes the run's own open question without resuming anyone", async () => {
    const task = await svc.createTask(projectPath, { title: "Interactive task" });
    await svc.addQuestion(projectPath, task.id, "Ship now?", "run_int");
    await svc.addQuestion(projectPath, task.id, "Also this?", "run_int");
    const before = delivered.length;

    const missing = await svc.resolveQuestion(projectPath, task.id, "run_int", "yes", "q_nope");
    expect(missing.ok).toBe(false);

    // Without a questionId it closes the run's *newest* open question.
    const ok = await svc.resolveQuestion(projectPath, task.id, "run_int", "ship it");
    expect(ok).toEqual({ ok: true });
    const t = (await loadProject()).tasks.find((x) => x.id === task.id)!;
    expect(t.questions.filter((q) => q.answer == null).map((q) => q.text)).toEqual(["Ship now?"]);
    const closed = t.questions.find((q) => q.text === "Also this?")!;
    expect(closed.answer).toContain("answered interactively");
    expect(closed.answer).toContain("ship it");
    // The asker already has the answer — nothing is delivered or resumed.
    expect(delivered.length).toBe(before);

    // A run cannot close a question it didn't raise.
    const foreign = await svc.resolveQuestion(projectPath, task.id, "run_other", "nope");
    expect(foreign.ok).toBe(false);
  });

  it("task detail includes acceptance criteria and question state", async () => {
    const task = await svc.createTask(projectPath, {
      title: "detailed",
      description: "Done means: green CI.",
    });
    await svc.addQuestion(projectPath, task.id, "Node 24 ok?", null);
    const detail = await svc.taskDetail(projectPath, task.id);
    expect(detail).toContain("Done means: green CI.");
    expect(detail).toContain('OPEN: "Node 24 ok?"');
  });
});
