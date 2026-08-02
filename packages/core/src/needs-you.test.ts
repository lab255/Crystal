import { describe, expect, it } from "vitest";
import {
  countOpenQuestions,
  countUnrecoveredFailures,
  deriveNeedsYou,
  type ProjectEntry,
} from "./needs-you.js";
import { createProject, createTask, createTaskQuestion, type Project } from "./project.js";
import { createAgentRun, type AgentRun } from "./agent.js";
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
      failedRun("r2", null), // ordinary failure — not surfaced
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
