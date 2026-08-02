import { describe, expect, it } from "vitest";
import type { AgentRun } from "./agent.js";
import { createTask, createTaskQuestion, type TaskItem, type TaskStatus } from "./project.js";
import {
  liveRunIds,
  sortTasksByAttention,
  taskAttention,
} from "./task-attention.js";

/**
 * The attention grouping is the shared ordering of every "jump to a task"
 * surface. Invariants under test: an open question outranks everything (even
 * done), a live run outranks board status, statuses fall in workflow order
 * with done last, and ties break by priority then recency.
 */

function task(
  title: string,
  status: TaskStatus,
  patch: Partial<TaskItem> = {},
): TaskItem {
  return { ...createTask(title, status), ...patch };
}

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
