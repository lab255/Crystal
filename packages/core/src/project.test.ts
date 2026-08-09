import { describe, expect, it } from "vitest";
import {
  createTask,
  createTaskQuestion,
  isQuestionOpen,
  openQuestions,
  questionClosure,
  TaskQuestionSchema,
  type TaskQuestion,
} from "./project.js";

function q(over: Partial<TaskQuestion> = {}): TaskQuestion {
  return {
    ...createTaskQuestion("Which schema?", "run_1"),
    ...over,
  };
}

describe("isQuestionOpen / questionClosure", () => {
  it("a fresh question is open with no closure", () => {
    const question = q();
    expect(isQuestionOpen(question)).toBe(true);
    expect(questionClosure(question)).toBeNull();
  });

  it("legacy precedence: answer != null with no closed stamp reads as closed/answered", () => {
    const legacy = q({ answer: "Version it.", answeredAt: "2026-01-02T00:00:00Z" });
    expect(legacy.closed ?? null).toBeNull();
    expect(isQuestionOpen(legacy)).toBe(false);
    expect(questionClosure(legacy)).toEqual({
      at: "2026-01-02T00:00:00Z",
      reason: "answered",
      note: null,
      by: "user",
    });
  });

  it("a legacy answered record without answeredAt synthesizes from createdAt", () => {
    const legacy = q({ answer: "yes", answeredAt: null, createdAt: "2026-01-01T00:00:00Z" });
    expect(questionClosure(legacy)!.at).toBe("2026-01-01T00:00:00Z");
  });

  it("closed wins over answer == null (dismissed/expired records read closed)", () => {
    const dismissed = q({
      closed: { at: "t1", reason: "dismissed", note: "stale", by: "user" },
    });
    expect(dismissed.answer ?? null).toBeNull();
    expect(isQuestionOpen(dismissed)).toBe(false);
    expect(questionClosure(dismissed)).toEqual({
      at: "t1",
      reason: "dismissed",
      note: "stale",
      by: "user",
    });
  });

  it("an explicit closed stamp wins over the synthesized legacy closure", () => {
    const both = q({
      answer: "yes",
      answeredAt: "t9",
      closed: { at: "t1", reason: "answered", note: null, by: "agent" },
    });
    expect(questionClosure(both)!.by).toBe("agent");
    expect(questionClosure(both)!.at).toBe("t1");
  });

  it("openQuestions filters through the one predicate", () => {
    const task = createTask("t");
    task.questions = [
      q({ id: "q_open" }),
      q({ id: "q_answered", answer: "done" }),
      q({ id: "q_expired", closed: { at: "t", reason: "expired", note: null, by: "system" } }),
    ];
    expect(openQuestions(task).map((question) => question.id)).toEqual(["q_open"]);
  });

  it("legacy records parse: new fields are additive with askedBy defaulting to agent", () => {
    const parsed = TaskQuestionSchema.parse({
      id: "q_legacy",
      text: "old record",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(parsed.askedBy).toBe("agent");
    expect(parsed.origin ?? null).toBeNull();
    expect(parsed.closed ?? null).toBeNull();
    expect(isQuestionOpen(parsed)).toBe(true);
  });

  it("createTaskQuestion stamps origin and askedBy", () => {
    const stamped = createTaskQuestion("t", "run_1", undefined, {
      origin: { workflowId: "wf_1" },
      askedBy: "user",
    });
    expect(stamped.origin).toEqual({ workflowId: "wf_1" });
    expect(stamped.askedBy).toBe("user");
    const plain = createTaskQuestion("t", "run_1");
    expect(plain.origin ?? null).toBeNull();
    expect(plain.askedBy).toBe("agent");
  });
});
