import { describe, expect, it } from "vitest";
import {
  attentionLight,
  countOpenQuestions,
  countUnrecoveredFailures,
  deriveNeedsYou,
  deriveRunAttention,
  workspaceLight,
  type AttentionRun,
  type ProjectEntry,
} from "./attention.js";
import { createProject, createTask, createTaskQuestion, type Project } from "./project.js";
import { createAgentRun, type AgentRun } from "./agent.js";
import { createTodoItem, type TodoItem } from "./todo.js";
import type { RunFailure } from "./run-failure.js";

function projectWithQuestions(name: string, questions: { text: string; answered?: boolean }[]): ProjectEntry {
  const project: Project = createProject(name);
  const task = createTask("A task");
  task.questions = questions.map((q) => {
    const question = createTaskQuestion(q.text, "run_x");
    if (q.answered) question.answer = "done";
    return question;
  });
  project.tasks = [task];
  return { path: `.crystal/projects/${name}.crystal`, project };
}

function failedRun(id: string, failure: RunFailure | null, extra: Partial<AgentRun> = {}): AgentRun {
  const run = createAgentRun({ prompt: "x" });
  run.id = id;
  run.status = "failed";
  run.failure = failure;
  return { ...run, ...extra };
}

let nextId = 0;
const run = (
  status: AttentionRun["status"],
  endedAt: string | null = null,
  extra: Partial<AttentionRun> = {},
): AttentionRun => ({ id: `run_${nextId++}`, status, endedAt, ...extra });

const OVERFLOW: RunFailure = { kind: "context_overflow", resetsAt: null, detail: null };

describe("deriveNeedsYou", () => {
  it("collects open questions across projects and ignores answered ones", () => {
    const projects = [
      projectWithQuestions("a", [{ text: "Q1" }, { text: "Q2", answered: true }]),
      projectWithQuestions("b", [{ text: "Q3" }]),
    ];
    const needs = deriveNeedsYou(projects, []);
    expect(needs.questions.map((q) => q.question.text).sort()).toEqual(["Q1", "Q3"]);
    expect(needs.questions[0]!.projectName).toBeTruthy();
    expect(needs.count).toBe(2);
  });

  it("counts recoverable-failed runs but not unclassified failures", () => {
    const runs = [
      failedRun("r1", OVERFLOW),
      failedRun("r2", null), // ordinary failure — review lane, not attention
    ];
    const needs = deriveNeedsYou([], runs);
    expect(needs.failures.map((r) => r.id)).toEqual(["r1"]);
  });

  it("treats a failure as recovered once a run resumes or hands off from it", () => {
    const overflowed = failedRun("r1", OVERFLOW);
    const handoff = createAgentRun({ prompt: "continue" });
    handoff.id = "r2";
    handoff.handoffFromRunId = "r1";
    const resumed = createAgentRun({ prompt: "retry" });
    resumed.id = "r3";
    resumed.status = "failed";
    resumed.failure = OVERFLOW;
    const laterResume = createAgentRun({ prompt: "again" });
    laterResume.id = "r4";
    laterResume.resumedFromRunId = "r3";

    const needs = deriveNeedsYou([], [overflowed, handoff, resumed, laterResume]);
    // r1 recovered via handoff, r3 recovered via resume → nothing waiting.
    expect(needs.failures).toHaveLength(0);
  });

  it("sorts failures newest-first and totals with questions", () => {
    const old = failedRun("old", OVERFLOW);
    old.createdAt = "2026-08-01T00:00:00.000Z";
    const recent = failedRun("recent", OVERFLOW);
    recent.createdAt = "2026-08-02T00:00:00.000Z";
    const needs = deriveNeedsYou(
      [projectWithQuestions("a", [{ text: "Q" }])],
      [old, recent],
    );
    expect(needs.failures.map((r) => r.id)).toEqual(["recent", "old"]);
    expect(needs.count).toBe(3); // 1 question + 2 failures
  });
});

describe("count helpers (selector-safe primitives)", () => {
  it("countOpenQuestions matches deriveNeedsYou's question count", () => {
    const projects = [
      projectWithQuestions("a", [{ text: "Q1" }, { text: "Q2", answered: true }]),
      projectWithQuestions("b", [{ text: "Q3" }]),
    ];
    expect(countOpenQuestions(projects)).toBe(2);
    expect(countOpenQuestions(projects)).toBe(deriveNeedsYou(projects, []).questions.length);
  });

  it("countUnrecoveredFailures matches deriveNeedsYou's failure count", () => {
    const overflowed = failedRun("r1", OVERFLOW);
    const recovered = createAgentRun({ prompt: "c" });
    recovered.handoffFromRunId = "r1";
    const other = failedRun("r2", OVERFLOW);
    const runs = [overflowed, recovered, other];
    expect(countUnrecoveredFailures(runs)).toBe(1); // r1 recovered, r2 open
    expect(countUnrecoveredFailures(runs)).toBe(deriveNeedsYou([], runs).failures.length);
  });
});

describe("deriveRunAttention", () => {
  it("is gray with no runs and green while agents execute", () => {
    expect(deriveRunAttention([], null).light).toBe("gray");
    expect(deriveRunAttention([run("running")], null).light).toBe("green");
    expect(deriveRunAttention([run("queued")], null).light).toBe("green");
  });

  it("puts unseen finishes in the review lane: yellow to review, red on failure", () => {
    const completed = deriveRunAttention([run("completed", "2026-01-02T00:00:00Z")], null);
    expect(completed).toMatchObject({ review: 1, reviewFailed: 0, light: "yellow" });
    const failed = deriveRunAttention([run("failed", "2026-01-02T00:00:00Z")], null);
    expect(failed).toMatchObject({ failures: 0, reviewFailed: 1, light: "red" });
  });

  it("the review lane goes quiet once seen; cancellations never surface", () => {
    const seen = "2026-01-03T00:00:00Z";
    expect(deriveRunAttention([run("failed", "2026-01-02T00:00:00Z")], seen).light).toBe("gray");
    expect(deriveRunAttention([run("failed", "2026-01-04T00:00:00Z")], seen).light).toBe("red");
    expect(deriveRunAttention([run("cancelled", "2026-01-04T00:00:00Z")], seen).light).toBe("gray");
  });

  it("an unrecovered recoverable failure is attention — red even after markSeen", () => {
    // THE convergence invariant: the pill counts it, so the light must show it.
    const seen = "2026-01-03T00:00:00Z";
    const runs = [run("failed", "2026-01-02T00:00:00Z", { id: "r1", failure: OVERFLOW })];
    const attn = deriveRunAttention(runs, seen);
    expect(attn).toMatchObject({ failures: 1, reviewFailed: 0, light: "red" });
    expect(attn.failures).toBe(countUnrecoveredFailures(runs));
  });

  it("recovery moves a classified failure out of attention into review", () => {
    const failed = run("failed", "2026-01-02T00:00:00Z", { id: "r1", failure: OVERFLOW });
    const recovery = run("running", null, { handoffFromRunId: "r1" });
    // Unseen: still red, but as an acknowledgeable review item now.
    expect(deriveRunAttention([failed, recovery], null)).toMatchObject({
      failures: 0,
      reviewFailed: 1,
    });
    // Seen: nothing left but the live recovery run.
    expect(deriveRunAttention([failed, recovery], "2026-01-03T00:00:00Z")).toMatchObject({
      failures: 0,
      reviewFailed: 0,
      light: "green",
    });
  });
});

describe("attentionLight / workspaceLight", () => {
  const todo = (patch: Partial<TodoItem>): TodoItem => ({ ...createTodoItem("x"), ...patch });

  it("an agent waiting on the human raises the light to yellow", () => {
    // An open board question is "needs attention": it clears only by
    // answering, never by acknowledging like run results do.
    expect(attentionLight([], null, 1)).toBe("yellow");
    expect(attentionLight([run("running")], null, 3)).toBe("yellow");
    expect(attentionLight([], null, 0)).toBe("gray");
    // Questions never outrank a real failure.
    expect(attentionLight([run("failed", "2026-01-02T00:00:00Z")], null, 5)).toBe("red");
  });

  it("workspaceLight combines todos with the attention lanes, worst wins", () => {
    expect(workspaceLight([], [], null)).toBe("gray");
    expect(workspaceLight([todo({ light: "yellow" })], [run("running")], null)).toBe("yellow");
    expect(
      workspaceLight([todo({ light: "yellow" })], [run("failed", "2026-01-02T00:00:00Z")], null),
    ).toBe("red");
    expect(workspaceLight([], [], null, 1)).toBe("yellow");
  });
});
