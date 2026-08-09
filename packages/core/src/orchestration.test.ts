import { describe, expect, it } from "vitest";
import { chainRootId, createAgentRun, touchedFileFromToolUse, type AgentRun } from "./agent.js";
import {
  claimLease,
  checkWrite,
  costSlices,
  estimateCostUsd,
  formatCost,
  leaseValid,
  mergeProjectSave,
  pricingForModel,
  rollupCost,
  sumCostRollups,
  taskLiveUsage,
  transferLease,
} from "./orchestration.js";
import {
  createProject,
  createTask,
  createTaskQuestion,
  readyTasks,
  type TaskLease,
} from "./project.js";

const NOW = Date.parse("2026-07-16T12:00:00Z");

function lease(overrides: Partial<TaskLease> = {}): TaskLease {
  return {
    claimId: "claim_a",
    holder: "agent-a",
    holderRunId: "run_a",
    acquiredAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

describe("leases (borrow checker)", () => {
  it("claims an unleased task and mints a claim id", () => {
    const result = claimLease(null, { holder: "agent-a", holderRunId: "run_a" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.stolen).toBe(false);
    expect(result.lease.claimId).toMatch(/^claim_/);
    expect(Date.parse(result.lease.expiresAt)).toBeGreaterThan(NOW);
  });

  it("denies a claim while a valid lease is held by someone else", () => {
    const result = claimLease(lease(), { holder: "agent-b" }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("agent-a");
  });

  it("steals a stale lease (healing)", () => {
    const stale = lease({ expiresAt: new Date(NOW - 1000).toISOString() });
    const result = claimLease(stale, { holder: "agent-b" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.stolen).toBe(true);
    expect(result.lease.holder).toBe("agent-b");
    expect(result.lease.claimId).not.toBe("claim_a");
  });

  it("heartbeats: the holder re-claims with its claim id and keeps the token", () => {
    const current = lease();
    const result = claimLease(
      current,
      { holder: "agent-a", claimId: "claim_a", ttlMs: 30 * 60_000 },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.stolen).toBe(false);
    expect(result.lease.claimId).toBe("claim_a");
    expect(result.lease.acquiredAt).toBe(current.acquiredAt);
    expect(Date.parse(result.lease.expiresAt)).toBe(NOW + 30 * 60_000);
  });

  it("checkWrite: no lease → denied, wrong claim → denied, holder → allowed, force → allowed", () => {
    expect(checkWrite(null, "claim_a", {}, NOW).ok).toBe(false);
    expect(checkWrite(lease(), "claim_b", {}, NOW).ok).toBe(false);
    expect(checkWrite(lease(), "claim_a", {}, NOW).ok).toBe(true);
    expect(checkWrite(lease(), null, { force: true }, NOW).ok).toBe(true);
  });

  it("an expired lease is not valid and does not authorize its old claim", () => {
    const stale = lease({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(leaseValid(stale, NOW)).toBe(false);
    expect(checkWrite(stale, "claim_a", {}, NOW).ok).toBe(false);
  });
});

describe("cost attribution", () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 10_000_000,
    cacheCreationTokens: 500_000,
    apiCalls: 12,
  };

  it("prices by model substring with a sonnet-class fallback", () => {
    expect(pricingForModel("claude-fable-5").output).toBe(50);
    expect(pricingForModel("claude-opus-4-8").input).toBe(5);
    expect(pricingForModel("something-new").input).toBe(3);
  });

  it("estimates dollars from usage classes (cache reads at a tenth of input)", () => {
    // fable: 1M in ×$10 + 0.1M out ×$50 + 10M cache-read ×$1 + 0.5M cache-write ×$12.5
    expect(estimateCostUsd("claude-fable-5", usage)).toBeCloseTo(10 + 5 + 10 + 6.25, 5);
  });

  function run(model: string, costUsd: number | null): AgentRun {
    const r = createAgentRun({ prompt: "x" });
    r.model = model;
    r.usage = usage;
    r.costUsd = costUsd;
    return r;
  }

  it("rolls up runs by model, preferring the CLI-reported bill", () => {
    const rollup = rollupCost([run("claude-fable-5", 2.5), run("claude-haiku-4-5", null)]);
    expect(rollup.runCount).toBe(2);
    // 11.6M tokens per run, cache reads included.
    expect(rollup.totalTokens).toBe(2 * 11_600_000);
    // fable run: reported $2.50; haiku run: estimated 1+0.5+1+0.625 = $3.125.
    expect(rollup.costUsd).toBeCloseTo(2.5 + 3.125, 5);
    expect(Object.keys(rollup.byModel).sort()).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
  });

  it("sums rollups for epic totals and skips nulls", () => {
    const a = rollupCost([run("m", 1)]);
    const sum = sumCostRollups([a, null, a]);
    expect(sum).not.toBeNull();
    expect(sum!.costUsd).toBeCloseTo(2, 5);
    expect(sum!.runCount).toBe(2);
    expect(sumCostRollups([null, undefined])).toBeNull();
  });

  it("formats board-column cost", () => {
    const rollup = rollupCost([run("m", 3.42)]);
    expect(formatCost(rollup)).toBe("11600k tok · $3.42");
    expect(formatCost(null)).toBe("");
  });
});

describe("transferLease", () => {
  it("hands the lease to the worker run, keeping the claim id and extending the TTL", () => {
    const shortLease = lease({ expiresAt: new Date(NOW + 5_000).toISOString() });
    const moved = transferLease(shortLease, "run_a", { runId: "run_worker" }, NOW);
    expect(moved).not.toBeNull();
    expect(moved!.claimId).toBe("claim_a");
    expect(moved!.holderRunId).toBe("run_worker");
    expect(Date.parse(moved!.expiresAt)).toBeGreaterThan(NOW + 5_000);
  });

  it("refuses when the lease is stale or held by a different run", () => {
    expect(transferLease(null, "run_a", { runId: "w" }, NOW)).toBeNull();
    const stale = lease({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(transferLease(stale, "run_a", { runId: "w" }, NOW)).toBeNull();
    expect(transferLease(lease(), "run_other", { runId: "w" }, NOW)).toBeNull();
  });
});

describe("run chains and touched files", () => {
  it("chainRootId follows resume links to the original manager", () => {
    const root = createAgentRun({ prompt: "manage", role: "manager" });
    const wake1 = createAgentRun({ prompt: "wake", role: "manager", resumedFromRunId: root.id });
    const wake2 = createAgentRun({ prompt: "wake", role: "manager", resumedFromRunId: wake1.id });
    const byId = new Map([root, wake1, wake2].map((r) => [r.id, r]));
    expect(chainRootId(wake2.id, byId)).toBe(root.id);
    expect(chainRootId(root.id, byId)).toBe(root.id);
    expect(chainRootId("run_unknown", byId)).toBe("run_unknown");
  });

  it("touchedFileFromToolUse recognizes edit-family tools only", () => {
    expect(touchedFileFromToolUse("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(touchedFileFromToolUse("Write", { file_path: "/c.md" })).toBe("/c.md");
    expect(touchedFileFromToolUse("NotebookEdit", { notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
    expect(touchedFileFromToolUse("Bash", { command: "rm -rf /" })).toBeNull();
    expect(touchedFileFromToolUse("Edit", {})).toBeNull();
  });
});

describe("taskLiveUsage", () => {
  function runFor(taskId: string, status: AgentRun["status"], tokens: number, cost: number): AgentRun {
    const r = createAgentRun({ prompt: "x", taskId });
    r.status = status;
    r.usage = { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 1 };
    r.costUsd = cost;
    return r;
  }

  it("adds live runs on top of the durable rollup without double counting settled ones", () => {
    const task = createTask("t");
    task.cost = { totalTokens: 5000, costUsd: 1, runCount: 3, byModel: {}, updatedAt: "x" };
    // A settled run (already inside the rollup) and a live one (not yet).
    const settled = runFor(task.id, "completed", 2000, 0.4);
    const live = runFor(task.id, "running", 300, 0.05);
    const usage = taskLiveUsage(task, [settled, live]);
    expect(usage).toEqual({ tokens: 5300, costUsd: 1.05 });
  });

  it("falls back to summing attributed runs when no rollup exists", () => {
    const task = createTask("t");
    const usage = taskLiveUsage(task, [
      runFor(task.id, "completed", 1000, 0.2),
      runFor(task.id, "running", 100, 0.01),
      runFor("other", "completed", 9999, 9),
    ]);
    expect(usage!.tokens).toBe(1100);
    expect(usage!.costUsd).toBeCloseTo(0.21, 5);
    expect(taskLiveUsage(createTask("empty"), [])).toBeNull();
  });
});

describe("costSlices", () => {
  function runFor(
    taskId: string | null,
    status: AgentRun["status"],
    cost: number,
    over: Partial<AgentRun> = {},
  ): AgentRun {
    const r = createAgentRun({ prompt: "x", taskId, tags: over.tags });
    r.status = status;
    r.usage = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 1 };
    r.costUsd = cost;
    Object.assign(r, over, { tags: r.tags });
    return r;
  }

  function board() {
    const project = createProject("p");
    const epic = { id: "epic_ui", name: "UI polish", description: "" };
    project.epics.push(epic);
    const a = createTask("build picker");
    a.epicId = "epic_ui";
    a.owners = { agentId: null, human: "eliot" };
    a.labels = ["area:ui", "area:sdk"];
    a.cost = { totalTokens: 1000, costUsd: 2, runCount: 1, byModel: { opus: { totalTokens: 1000, costUsd: 2 } }, updatedAt: "x" };
    const b = createTask("index db");
    b.owners = { agentId: null, human: "" };
    b.labels = ["area:db"];
    b.cost = { totalTokens: 500, costUsd: 1, runCount: 1, byModel: { sonnet: { totalTokens: 500, costUsd: 1 } }, updatedAt: "x" };
    project.tasks.push(a, b);
    return { project, a, b };
  }

  it("slices by epic, with un-epiced tasks and non-task runs kept visible", () => {
    const { project } = board();
    const orphan = runFor(null, "completed", 0.5);
    const slices = costSlices("epic", project, [orphan]);
    expect(slices.map((s) => s.label)).toEqual(["UI polish", "No epic", "No task (managers, jobs, consoles)"]);
    expect(slices[0]!.costUsd).toBeCloseTo(2);
    expect(slices[0]!.byModel[0]).toEqual({ model: "opus", costUsd: 2 });
    expect(slices[2]!.runCount).toBe(1);
    // The view's total reconciles with everything actually spent.
    expect(slices.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(3.5);
  });

  it("slices by human owner with an Unassigned residue", () => {
    const { project } = board();
    const slices = costSlices("human", project, []);
    expect(slices.map((s) => s.label)).toEqual(["eliot", "Unassigned"]);
  });

  it("tag slices are a lens, not a partition — multi-tagged tasks count fully in each", () => {
    const { project } = board();
    const slices = costSlices("tag:area", project, []);
    const byLabel = new Map(slices.map((s) => [s.label, s.costUsd]));
    expect(byLabel.get("ui")).toBeCloseTo(2);
    expect(byLabel.get("sdk")).toBeCloseTo(2); // full bill in both dimensions' values
    expect(byLabel.get("db")).toBeCloseTo(1);
  });

  it("adds live runs on top of the durable rollup and counts them live", () => {
    const { project, a } = board();
    const live = runFor(a.id, "running", 0.25, { model: "opus" });
    const slices = costSlices("epic", project, [live]);
    expect(slices[0]!.costUsd).toBeCloseTo(2.25);
    expect(slices[0]!.liveCount).toBe(1);
  });

  it("residue slices trail real slices they tie with, on every axis", () => {
    const project = createProject("p");
    const epic = { id: "epic_a", name: "Real epic", description: "" };
    project.epics.push(epic);
    const inEpic = createTask("in epic");
    inEpic.epicId = "epic_a";
    inEpic.cost = { totalTokens: 100, costUsd: 1, runCount: 1, byModel: {}, updatedAt: "x" };
    const noEpic = createTask("no epic");
    noEpic.cost = { totalTokens: 100, costUsd: 1, runCount: 1, byModel: {}, updatedAt: "x" };
    // "No epic" iterates first from the task order — it must still trail.
    project.tasks.push(noEpic, inEpic);
    const slices = costSlices("epic", project, []);
    expect(slices.map((s) => s.label)).toEqual(["Real epic", "No epic"]);
  });

  it("keeps spend of deleted tasks visible in the No-task residue", () => {
    const { project } = board();
    const deletedTaskRun = runFor("task_deleted", "completed", 0.75);
    deletedTaskRun.projectId = project.id;
    const otherBoardRun = runFor("task_other", "completed", 9);
    otherBoardRun.projectId = "proj_other";
    const slices = costSlices("epic", project, [deletedTaskRun, otherBoardRun]);
    const residue = slices.find((s) => s.label.startsWith("No task"));
    // The deleted task's bill reconciles here; another board's task-runs don't leak in.
    expect(residue?.costUsd).toBeCloseTo(0.75);
  });

  it("slices runs by workflow and agent attribution tags", () => {
    const w1 = runFor(null, "completed", 1, { tags: ["workflow:wf_a"] });
    const w2 = runFor(null, "completed", 2, { tags: ["workflow:wf_a"] });
    const solo = runFor(null, "completed", 0.5);
    const byWorkflow = costSlices("workflow", null, [w1, w2, solo]);
    expect(byWorkflow[0]).toMatchObject({ key: "wf_a", costUsd: 3, runCount: 2 });
    expect(byWorkflow[1]!.label).toBe("No workflow");

    const agented = runFor(null, "completed", 4, { tags: ["agent:agent_generalist"] });
    const byAgent = costSlices("agent", null, [agented]);
    expect(byAgent[0]).toMatchObject({ key: "agent_generalist", costUsd: 4 });
  });
});

describe("mergeProjectSave", () => {
  function boardWith(rev: number): ReturnType<typeof createProject> {
    const project = createProject("p");
    project.rev = rev;
    return project;
  }

  it("applies a fresh-rev save wholesale, keeping server-owned columns", () => {
    const disk = boardWith(4);
    const task = createTask("keep");
    task.lease = lease();
    disk.tasks = [task];
    const incoming = structuredClone({ ...disk, name: "renamed" });
    incoming.tasks[0]!.lease = null; // client can never write leases
    incoming.tasks[0]!.status = "done";
    const merged = mergeProjectSave(disk, incoming);
    expect(merged.name).toBe("renamed");
    expect(merged.tasks[0]!.status).toBe("done");
    expect(merged.tasks[0]!.lease?.claimId).toBe("claim_a");
    expect(merged.rev).toBe(4); // caller bumps rev, not the merge
  });

  it("fresh-rev saves still apply user deletions", () => {
    const disk = boardWith(2);
    disk.tasks = [createTask("delete me")];
    const incoming = structuredClone(disk);
    incoming.tasks = [];
    expect(mergeProjectSave(disk, incoming).tasks).toHaveLength(0);
  });

  it("a stale save cannot delete or revert agent writes", () => {
    const disk = boardWith(7);
    const contested = createTask("contested");
    contested.status = "done"; // agent moved it after the client snapshot
    contested.updatedAt = "2026-07-17T12:00:00Z";
    const agentMade = createTask("agent created this");
    disk.tasks = [contested, agentMade];

    const incoming = boardWith(6); // stale rev
    incoming.id = disk.id;
    const clientCopy = structuredClone(contested);
    clientCopy.status = "backlog"; // the client's snapshot predates the agent write
    clientCopy.updatedAt = "2026-07-17T11:00:00Z";
    const userMade = createTask("user created this");
    incoming.tasks = [clientCopy, userMade]; // agentMade missing from the snapshot

    const merged = mergeProjectSave(disk, incoming);
    const titles = merged.tasks.map((t) => t.title);
    expect(titles).toContain("agent created this"); // not deleted by the stale save
    expect(titles).toContain("user created this"); // user's new task still lands
    expect(merged.tasks.find((t) => t.id === contested.id)!.status).toBe("done"); // newer write wins
  });

  it("questions and runIds are server-owned: a stale save cannot resurrect a closed question", () => {
    const disk = boardWith(7);
    const task = createTask("asked");
    task.updatedAt = "2026-07-17T10:00:00Z";
    const question = createTaskQuestion("Ship it?", "run_1");
    question.answer = "yes";
    question.answeredAt = "2026-07-17T11:00:00Z";
    question.closed = { at: "2026-07-17T11:00:00Z", reason: "answered", note: null, by: "user" };
    task.questions = [question];
    task.runIds = ["run_1", "run_resumed"];
    disk.tasks = [task];

    // The client snapshot predates the answer AND wins the row on updatedAt —
    // its open copy of the question (and shorter runIds) must still lose.
    const incoming = boardWith(3);
    incoming.id = disk.id;
    const staleTask = structuredClone(task);
    staleTask.updatedAt = "2026-07-17T12:00:00Z"; // user edited the title later
    staleTask.title = "asked (renamed)";
    staleTask.questions = [{ ...question, answer: null, answeredAt: null, closed: null }];
    staleTask.runIds = ["run_1"];
    incoming.tasks = [staleTask];

    const merged = mergeProjectSave(disk, incoming);
    const row = merged.tasks[0]!;
    expect(row.title).toBe("asked (renamed)"); // client-owned edit applied
    expect(row.questions[0]!.answer).toBe("yes"); // closure survived
    expect(row.questions[0]!.closed).toMatchObject({ reason: "answered" });
    expect(row.runIds).toEqual(["run_1", "run_resumed"]);

    // Fresh-rev saves defer to disk the same way (questions have their own verbs).
    const fresh = structuredClone(incoming);
    fresh.rev = 7;
    expect(mergeProjectSave(disk, fresh).tasks[0]!.questions[0]!.answer).toBe("yes");

    // A task the server has never seen keeps the client's copies.
    const newTask = createTask("brand new");
    newTask.questions = [createTaskQuestion("From the client?", null)];
    const withNew = structuredClone(incoming);
    withNew.tasks = [...withNew.tasks, newTask];
    const mergedNew = mergeProjectSave(disk, withNew);
    expect(
      mergedNew.tasks.find((t) => t.id === newTask.id)!.questions.map((q) => q.text),
    ).toEqual(["From the client?"]);
  });

  it("a stale save still applies the user's newer per-task edits", () => {
    const disk = boardWith(7);
    const task = createTask("t");
    task.updatedAt = "2026-07-17T10:00:00Z";
    disk.tasks = [task];
    const incoming = boardWith(3);
    incoming.id = disk.id;
    const edited = structuredClone(task);
    edited.title = "user edit";
    edited.updatedAt = "2026-07-17T12:00:00Z";
    incoming.tasks = [edited];
    expect(mergeProjectSave(disk, incoming).tasks[0]!.title).toBe("user edit");
  });
});

describe("readyTasks", () => {
  it("returns unblocked backlog tasks, highest priority first", () => {
    const project = createProject("p");
    const done = createTask("done work");
    done.status = "done";
    const blocked = createTask("blocked");
    blocked.blockedBy = ["missing-task", done.id]; // missing blocker counts as done
    const gated = createTask("gated");
    const urgent = createTask("urgent");
    urgent.priority = "urgent";
    gated.blockedBy = [urgent.id]; // urgent is backlog → gated not ready
    project.tasks = [done, blocked, gated, urgent];
    expect(readyTasks(project).map((t) => t.title)).toEqual(["urgent", "blocked"]);
  });
});
