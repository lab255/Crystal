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
  const q = createTaskQuestion("Which flavor?", "run_q");
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
