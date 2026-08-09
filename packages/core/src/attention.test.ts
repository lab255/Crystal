import { describe, expect, it } from "vitest";
import {
  ActiveTransitionTracker,
  AttentionTracker,
  attentionLight,
  automaticWorkflowPauseIds,
  countActionableQuestions,
  countOpenQuestions,
  fleetNeedsYouCount,
  countPendingPermissions,
  countUnrecoveredFailures,
  deriveNeedsYou,
  deriveRunAttention,
  failureAttentionId,
  questionAttentionId,
  runAttentionId,
  settledRunReviews,
  unrecoveredFailures,
  workflowPauseAttentionId,
  workspaceLight,
  type AttentionRun,
  type ProjectEntry,
} from "./attention.js";
import { createProject, createTask, createTaskQuestion, type Project } from "./project.js";
import { countActionableQuestionRows, livenessIndex } from "./question-liveness.js";
import { createAgentRun, type AgentRun } from "./agent.js";
import { createTodoItem, type TodoItem } from "./todo.js";
import type { RunFailure } from "./run-failure.js";

function projectWithQuestions(name: string, questions: { text: string; answered?: boolean }[]): ProjectEntry {
  const project: Project = createProject(name);
  const task = createTask("A task");
  task.questions = questions.map((q) => {
    const question = createTaskQuestion(q.text, null, undefined, { askedBy: "user" });
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

  it("includes parked permissions in the attention lane", () => {
    const permissions = [
      {
        id: "permission-1",
        runId: "run-1",
        tool: "Bash",
        summary: "pnpm test",
        requestedAt: "2026-08-09T00:00:00.000Z",
      },
    ];
    const needs = deriveNeedsYou([], [], permissions);
    expect(needs.permissions).toEqual(permissions);
    expect(needs.count).toBe(1);
    expect(countPendingPermissions(permissions)).toBe(1);
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

  it("unrecoveredFailures is the list deriveNeedsYou surfaces", () => {
    const runs = [failedRun("r1", OVERFLOW), failedRun("r2", null)];
    expect(unrecoveredFailures(runs).map((r) => r.id)).toEqual(
      deriveNeedsYou([], runs).failures.map((r) => r.id),
    );
  });

  it("countActionableQuestions drops stale (open+undeliverable) questions, keeps unknown", () => {
    const projects = [
      projectWithQuestions("a", [{ text: "Q1" }, { text: "Q2", answered: true }]),
      projectWithQuestions("b", [{ text: "Q3" }]),
    ];
    for (const { project } of projects) {
      for (const question of project.tasks.flatMap((task) => task.questions)) {
        question.askedBy = "agent";
        question.runId = "run_x";
      }
    }
    // No run "run_x" in the index — both open questions are stale.
    expect(countActionableQuestions(projects, livenessIndex([]))).toBe(0);
    // A live asking chain keeps them counted.
    const live = livenessIndex([
      { id: "run_x", status: "running", createdAt: "t1" },
    ]);
    expect(countActionableQuestions(projects, live)).toBe(2);
    // An unavailable index is not evidence of death — same as the plain count.
    expect(countActionableQuestions(projects, null)).toBe(countOpenQuestions(projects));
  });

  it("counts annotated rows with the same user-before-run policy", () => {
    const user = createTaskQuestion("manual", null, undefined, { askedBy: "user" });
    const agent = createTaskQuestion("agent", "gone");
    expect(
      countActionableQuestionRows([
        { question: user, deliverability: "undeliverable" },
        { question: agent, deliverability: "undeliverable" },
      ]),
    ).toBe(1);
  });

  it("fleetNeedsYouCount sums workspace rows with their pending permissions", () => {
    const rows = [
      { key: "c1:ws1", count: 2 },
      { key: "c1:ws2", count: 0 },
    ];
    const permissions = {
      "c1:ws2": [
        { id: "p1", runId: "r", tool: "Bash", summary: "s", requestedAt: "t" },
      ],
    };
    expect(fleetNeedsYouCount(rows, permissions)).toBe(3);
    expect(fleetNeedsYouCount(rows, {})).toBe(2);
  });
});

describe("AttentionTracker", () => {
  it("seeds a source's first snapshot silently, then reports only new ids", () => {
    const tracker = new AttentionTracker();
    expect(tracker.next("ws1:questions", ["q:1", "q:2"])).toEqual([]); // reload — no spam
    expect(tracker.next("ws1:questions", ["q:1", "q:2"])).toEqual([]);
    expect(tracker.next("ws1:questions", ["q:1", "q:2", "q:3"])).toEqual(["q:3"]);
    // Already announced — resolving and re-listing never re-announces.
    expect(tracker.next("ws1:questions", ["q:3"])).toEqual([]);
  });

  it("seeds each source independently (late-arriving halves are not transitions)", () => {
    const tracker = new AttentionTracker();
    tracker.next("ws1:failures", ["f:a"]);
    // The question recount lands later — still that source's first snapshot.
    expect(tracker.next("ws1:questions", ["q:1"])).toEqual([]);
    expect(tracker.next("ws1:questions", ["q:1", "q:2"])).toEqual(["q:2"]);
    // A workspace opened mid-session seeds fresh too.
    expect(tracker.next("ws2:failures", ["f:b"])).toEqual([]);
  });

  it("claims a run once across failure and review sources", () => {
    const tracker = new AttentionTracker();
    tracker.next("ws1:failures", []);
    tracker.next("ws1:reviews", []);
    expect(tracker.next("ws1:failures", ["f:run"])).toEqual(["f:run"]);
    expect(tracker.next("ws1:reviews", ["f:run"])).toEqual([]);
  });

  it("attention ids are namespaced so a question and a run cannot collide", () => {
    const project = projectWithQuestions("a", [{ text: "Q" }]);
    const q = deriveNeedsYou([project], []).questions[0]!;
    const run = failedRun(q.question.id, OVERFLOW); // pathological same raw id
    expect(questionAttentionId(q.question)).not.toBe(failureAttentionId(run));
    expect(failureAttentionId(run)).toBe(runAttentionId(run));
  });
});

describe("ActiveTransitionTracker", () => {
  it("seeds silently, reports entries, and re-arms ids that leave", () => {
    const tracker = new ActiveTransitionTracker();
    expect(tracker.next("ws1:workflow-pauses", ["w:existing"])).toEqual([]);
    expect(tracker.next("ws1:workflow-pauses", ["w:existing", "w:new"])).toEqual(["w:new"]);
    expect(tracker.next("ws1:workflow-pauses", ["w:existing", "w:new"])).toEqual([]);
    expect(tracker.next("ws1:workflow-pauses", [])).toEqual([]);
    expect(tracker.next("ws1:workflow-pauses", ["w:new"])).toEqual(["w:new"]);
    // Another workspace still seeds independently.
    expect(tracker.next("ws2:workflow-pauses", ["w:new"])).toEqual([]);
  });
});

describe("automatic workflow pauses", () => {
  it("includes budget/stall pauses but not user holds or running workflows", () => {
    const workflows = [
      { id: "budget", status: "paused" as const, pausedBy: "budget" as const },
      { id: "stall", status: "paused" as const, pausedBy: "stall" as const },
      { id: "user", status: "paused" as const, pausedBy: "user" as const },
      { id: "running", status: "running" as const, pausedBy: null },
    ];
    expect(automaticWorkflowPauseIds(workflows)).toEqual(["w:budget", "w:stall"]);
    expect(workflowPauseAttentionId(workflows[0]!)).toBe("w:budget");
  });
});

describe("settledRunReviews", () => {
  it("itemizes the same settled review lanes and excludes live/cancelled/recoverable failures", () => {
    const completed = run("completed", "2026-01-02T00:00:00Z", { id: "completed" });
    const failed = run("failed", "2026-01-02T00:00:00Z", { id: "failed" });
    const recoverable = run("failed", "2026-01-02T00:00:00Z", {
      id: "recoverable",
      failure: OVERFLOW,
    });
    const running = run("running", null, { id: "running" });
    const cancelled = run("cancelled", "2026-01-02T00:00:00Z", { id: "cancelled" });

    const reviews = settledRunReviews([completed, failed, recoverable, running, cancelled]);
    expect(reviews.review.map((item) => item.id)).toEqual(["completed"]);
    expect(reviews.reviewFailed.map((item) => item.id)).toEqual(["failed"]);
  });

  it("moves a recovered classified failure into reviewFailed", () => {
    const failed = run("failed", "2026-01-02T00:00:00Z", {
      id: "failed",
      failure: OVERFLOW,
    });
    const recovery = run("running", null, { id: "recovery", handoffFromRunId: "failed" });
    expect(settledRunReviews([failed, recovery]).reviewFailed.map((item) => item.id)).toEqual([
      "failed",
    ]);
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
