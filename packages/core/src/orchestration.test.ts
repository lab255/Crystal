import { describe, expect, it } from "vitest";
import { chainRootId, createAgentRun, touchedFileFromToolUse, type AgentRun } from "./agent.js";
import {
  claimLease,
  checkWrite,
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
import { createProject, createTask, readyTasks, type TaskLease } from "./project.js";

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
