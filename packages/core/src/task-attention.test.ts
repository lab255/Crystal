import { describe, expect, it } from "vitest";
import { createAgentRun, type AgentRun } from "./agent.js";
import {
  createProject,
  createTask,
  createTaskQuestion,
  type Project,
  type TaskItem,
  type TaskStatus,
} from "./project.js";
import type { RunFailure } from "./run-failure.js";
import {
  deriveTaskAttention,
  firstAttentionTask,
  formatWaitedFor,
  groupTasksForList,
  liveRunIds,
  sortTasksByAttention,
  taskAttention,
  taskPulse,
} from "./task-attention.js";

const OVERFLOW: RunFailure = { kind: "context_overflow", resetsAt: null, detail: null };

function task(title: string, status: TaskStatus = "backlog", patch: Partial<TaskItem> = {}): TaskItem {
  return { ...createTask(title, status), ...patch };
}

function taskRun(taskId: string, patch: Partial<AgentRun> = {}): AgentRun {
  const run = createAgentRun({ prompt: "x", taskId });
  return { ...run, ...patch };
}

function withQuestion(t: TaskItem, createdAt: string, answered = false): TaskItem {
  const q = createTaskQuestion("Which flavor?", null, undefined, { askedBy: "user" });
  q.createdAt = createdAt;
  if (answered) q.answer = "vanilla";
  return { ...t, questions: [...t.questions, q] };
}

function projectOf(...tasks: TaskItem[]): Project {
  const project = createProject("p");
  project.tasks = tasks;
  return project;
}

describe("deriveTaskAttention", () => {
  it("is null for a quiet task", () => {
    expect(deriveTaskAttention(task("t"), [])).toBeNull();
  });

  it("flags open questions with the oldest as waitingSince", () => {
    let t = withQuestion(task("t"), "2026-08-02T10:00:00.000Z");
    t = withQuestion(t, "2026-08-02T08:00:00.000Z");
    const att = deriveTaskAttention(t, []);
    expect(att?.kinds).toEqual(["question"]);
    expect(att?.waitingSince).toBe("2026-08-02T08:00:00.000Z");
  });

  it("ignores answered questions", () => {
    const t = withQuestion(task("t"), "2026-08-02T08:00:00.000Z", true);
    expect(deriveTaskAttention(t, [])).toBeNull();
  });

  it("flags an unrecovered classified failure on the task's own runs only", () => {
    const t = task("t");
    const mine = taskRun(t.id, {
      id: "r1",
      status: "failed",
      failure: OVERFLOW,
      endedAt: "2026-08-02T09:00:00.000Z",
    });
    const someoneElses = taskRun("other-task", { id: "r2", status: "failed", failure: OVERFLOW });
    const att = deriveTaskAttention(t, [mine, someoneElses]);
    expect(att?.kinds).toEqual(["failure"]);
    expect(att?.waitingSince).toBe("2026-08-02T09:00:00.000Z");
  });

  it("does not flag recovered or unclassified failures", () => {
    const t = task("t");
    const failed = taskRun(t.id, { id: "r1", status: "failed", failure: OVERFLOW });
    const handoff = taskRun(t.id, { id: "r2", handoffFromRunId: "r1" });
    const plainFail = taskRun(t.id, { id: "r3", status: "failed", failure: null });
    expect(deriveTaskAttention(t, [failed, handoff, plainFail])).toBeNull();
  });

  it("combines kinds and takes the oldest timestamp across them", () => {
    const t = withQuestion(task("t"), "2026-08-02T10:00:00.000Z");
    const failed = taskRun(t.id, {
      id: "r1",
      status: "failed",
      failure: OVERFLOW,
      endedAt: "2026-08-02T07:00:00.000Z",
    });
    const att = deriveTaskAttention(t, [failed]);
    expect(att?.kinds.sort()).toEqual(["failure", "question"]);
    expect(att?.waitingSince).toBe("2026-08-02T07:00:00.000Z");
  });

  it("ignores stale agent questions and keeps actionable and user questions", () => {
    const stale = createTaskQuestion("old ask", "run_gone");
    stale.createdAt = "2026-08-02T06:00:00.000Z";
    const liveQuestion = createTaskQuestion("live ask", "run_live");
    liveQuestion.createdAt = "2026-08-02T09:00:00.000Z";
    const liveRun = taskRun("other", {
      id: "run_live",
      status: "running",
      createdAt: "2026-08-02T08:00:00.000Z",
    });
    const t = task("t", "in_progress", { questions: [stale, liveQuestion] });
    expect(deriveTaskAttention(t, [liveRun])).toEqual({
      kinds: ["question"],
      waitingSince: liveQuestion.createdAt,
    });

    const userQuestion = createTaskQuestion("manual", null, undefined, { askedBy: "user" });
    expect(
      deriveTaskAttention(task("manual", "backlog", { questions: [userQuestion] }), []),
    ).toMatchObject({ kinds: ["question"] });
  });

  it("groups a stale-only task by its plain status and does not pulse", () => {
    const stale = createTaskQuestion("gone", "run_gone");
    const t = task("stale only", "in_progress", { questions: [stale] });
    expect(deriveTaskAttention(t, [])).toBeNull();
    expect(taskPulse(t, [])).toBe("idle");
    const groups = groupTasksForList(projectOf(t), []);
    expect(groups.find((group) => group.id === "attention")!.tasks).toEqual([]);
    expect(groups.find((group) => group.id === "in_progress")!.tasks).toEqual([t]);
  });
});

describe("taskPulse", () => {
  it("attention beats running beats idle", () => {
    const t = withQuestion(task("t", "in_progress"), "2026-08-02T08:00:00.000Z");
    const live = taskRun(t.id, { status: "running" });
    expect(taskPulse(t, [live])).toBe("attention");

    const quiet = task("q", "in_progress");
    expect(taskPulse(quiet, [taskRun(quiet.id, { status: "running" })])).toBe("running");
    expect(taskPulse(quiet, [taskRun(quiet.id, { status: "completed" })])).toBe("idle");
  });
});

describe("groupTasksForList", () => {
  it("pins attention tasks out of their status group, longest-waiting first", () => {
    const older = withQuestion(task("older", "in_progress"), "2026-08-02T08:00:00.000Z");
    const newer = withQuestion(task("newer", "backlog"), "2026-08-02T09:00:00.000Z");
    const quiet = task("quiet", "in_progress");
    const groups = groupTasksForList(projectOf(older, newer, quiet), []);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

    expect(byId.attention!.tasks.map((t) => t.title)).toEqual(["older", "newer"]);
    expect(byId.attention!.attention).toHaveLength(2);
    expect(byId.in_progress!.tasks.map((t) => t.title)).toEqual(["quiet"]);
    expect(byId.ready!.tasks).toHaveLength(0);
  });

  it("splits backlog into ready and blocked; deleted blockers do not block", () => {
    const blocker = task("blocker", "in_progress");
    const blocked = task("blocked", "backlog", { blockedBy: [blocker.id] });
    const freed = task("freed", "backlog", { blockedBy: ["gone-task"] });
    const groups = groupTasksForList(projectOf(blocker, blocked, freed), []);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId.blocked!.tasks.map((t) => t.title)).toEqual(["blocked"]);
    expect(byId.ready!.tasks.map((t) => t.title)).toEqual(["freed"]);
  });

  it("never flags done tasks for attention", () => {
    const done = withQuestion(task("done", "done"), "2026-08-02T08:00:00.000Z");
    const groups = groupTasksForList(projectOf(done), []);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId.attention!.tasks).toHaveLength(0);
    expect(byId.done!.tasks.map((t) => t.title)).toEqual(["done"]);
  });

  it("orders ready by priority then recency", () => {
    const low = task("low", "backlog", { priority: "low", updatedAt: "2026-08-02T10:00:00.000Z" });
    const urgent = task("urgent", "backlog", {
      priority: "urgent",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const groups = groupTasksForList(projectOf(low, urgent), []);
    const ready = groups.find((g) => g.id === "ready")!;
    expect(ready.tasks.map((t) => t.title)).toEqual(["urgent", "low"]);
  });
});

describe("firstAttentionTask", () => {
  it("lands on the longest-waiting attention task, else the first grouped task", () => {
    const waiting = withQuestion(task("waiting", "backlog"), "2026-08-02T08:00:00.000Z");
    const working = task("working", "in_progress");
    expect(firstAttentionTask(projectOf(waiting, working), [])?.title).toBe("waiting");
    expect(firstAttentionTask(projectOf(working), [])?.title).toBe("working");
    expect(firstAttentionTask(projectOf(), [])).toBeNull();
  });
});

describe("formatWaitedFor", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  it("formats minutes, hours and days", () => {
    expect(formatWaitedFor("2026-08-02T11:59:40.000Z", now)).toBe("<1m");
    expect(formatWaitedFor("2026-08-02T11:45:00.000Z", now)).toBe("15m");
    expect(formatWaitedFor("2026-08-02T09:00:00.000Z", now)).toBe("3h");
    expect(formatWaitedFor("2026-07-30T12:00:00.000Z", now)).toBe("3d");
  });
});

/* ------------------------------------------------------------------ */
/* Cross-workspace attention ordering (command palette)                */
/* ------------------------------------------------------------------ */

function run(id: string, status: AgentRun["status"]): Pick<AgentRun, "id" | "status"> {
  return { id, status };
}

describe("liveRunIds", () => {
  it("keeps only running and queued runs", () => {
    const live = liveRunIds([
      run("r1", "running"),
      run("r2", "queued"),
      run("r3", "completed"),
      run("r4", "failed"),
      run("r5", "cancelled"),
    ]);
    expect([...live].sort()).toEqual(["r1", "r2"]);
  });
});

describe("taskAttention", () => {
  const none = new Set<string>();

  it("maps board statuses to their groups", () => {
    expect(taskAttention(task("a", "backlog"), none)).toBe("backlog");
    expect(taskAttention(task("a", "in_progress"), none)).toBe("in_progress");
    expect(taskAttention(task("a", "review"), none)).toBe("review");
    expect(taskAttention(task("a", "done"), none)).toBe("done");
  });

  it("puts a task with a live run in 'running' regardless of status", () => {
    const t = task("a", "backlog", { runIds: ["r1", "r2"] });
    expect(taskAttention(t, new Set(["r2"]))).toBe("running");
    // A settled run is not attention — status wins again.
    expect(taskAttention(t, new Set(["other"]))).toBe("backlog");
  });

  it("an open question wins over everything, even done", () => {
    const q = createTaskQuestion("pick one");
    const t = task("a", "done", { questions: [q], runIds: ["r1"] });
    expect(taskAttention(t, new Set(["r1"]))).toBe("waiting");
    // An answered question is no longer waiting.
    const answered = { ...q, answer: "this one" };
    expect(taskAttention({ ...t, questions: [answered], runIds: [] }, new Set())).toBe("done");
  });
});

describe("sortTasksByAttention", () => {
  it("orders waiting > running > review > in_progress > backlog > done", () => {
    const waiting = task("waiting", "backlog", { questions: [createTaskQuestion("q")] });
    const running = task("running", "in_progress", { runIds: ["r1"] });
    const review = task("review", "review");
    const doing = task("doing", "in_progress");
    const idle = task("idle", "backlog");
    const done = task("done", "done");
    const sorted = sortTasksByAttention(
      [done, idle, doing, review, running, waiting],
      new Set(["r1"]),
    );
    expect(sorted.map((t) => t.title)).toEqual([
      "waiting",
      "running",
      "review",
      "doing",
      "idle",
      "done",
    ]);
  });

  it("breaks ties by priority, then recency", () => {
    const low = task("low", "backlog", { priority: "low", updatedAt: "2026-01-03T00:00:00Z" });
    const urgent = task("urgent", "backlog", {
      priority: "urgent",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const newer = task("newer", "backlog", { priority: "low", updatedAt: "2026-01-04T00:00:00Z" });
    const sorted = sortTasksByAttention([low, urgent, newer], new Set());
    expect(sorted.map((t) => t.title)).toEqual(["urgent", "newer", "low"]);
  });
});
