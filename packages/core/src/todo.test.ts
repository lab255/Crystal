import { describe, expect, it } from "vitest";
import type { AgentRunStatus } from "./agent.js";
import {
  createTodoItem,
  nextLight,
  runsLight,
  sortTodos,
  todosLight,
  workspaceLight,
  worstLight,
  type TodoItem,
} from "./todo.js";

const todo = (patch: Partial<TodoItem>): TodoItem => ({ ...createTodoItem("x"), ...patch });
const run = (status: AgentRunStatus, endedAt: string | null = null) => ({ status, endedAt });

describe("worstLight", () => {
  it("picks by severity, gray when empty", () => {
    expect(worstLight([])).toBe("gray");
    expect(worstLight(["gray", "green"])).toBe("green");
    expect(worstLight(["green", "red", "yellow"])).toBe("red");
    expect(worstLight(["green", "yellow"])).toBe("yellow");
  });
});

describe("nextLight", () => {
  it("cycles gray → green → yellow → red → gray", () => {
    expect(nextLight("gray")).toBe("green");
    expect(nextLight("green")).toBe("yellow");
    expect(nextLight("yellow")).toBe("red");
    expect(nextLight("red")).toBe("gray");
  });
});

describe("todosLight", () => {
  it("rolls up open items only", () => {
    expect(todosLight([])).toBe("gray");
    expect(todosLight([todo({ light: "red", done: true }), todo({ light: "green" })])).toBe("green");
    expect(todosLight([todo({ light: "yellow" }), todo({ light: "red" })])).toBe("red");
  });
});

describe("sortTodos", () => {
  it("orders urgent open items first and done items last", () => {
    const done = todo({ id: "done", light: "red", done: true });
    const green = todo({ id: "green", light: "green", order: 0 });
    const red = todo({ id: "red", light: "red", order: 5 });
    expect(sortTodos([done, green, red]).map((t) => t.id)).toEqual(["red", "green", "done"]);
  });

  it("uses manual order within a light", () => {
    const a = todo({ id: "a", light: "yellow", order: 2 });
    const b = todo({ id: "b", light: "yellow", order: 1 });
    expect(sortTodos([a, b]).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("runsLight", () => {
  it("is gray with no runs and green while agents execute", () => {
    expect(runsLight([], null)).toBe("gray");
    expect(runsLight([run("running")], null)).toBe("green");
    expect(runsLight([run("queued")], null)).toBe("green");
  });

  it("flags unseen finishes: yellow to review, red on failure", () => {
    expect(runsLight([run("completed", "2026-01-02T00:00:00Z")], null)).toBe("yellow");
    expect(runsLight([run("failed", "2026-01-02T00:00:00Z")], null)).toBe("red");
    expect(
      runsLight(
        [run("completed", "2026-01-02T00:00:00Z"), run("failed", "2026-01-02T00:00:00Z")],
        null,
      ),
    ).toBe("red");
  });

  it("goes quiet once results are seen; cancellations never raise it", () => {
    const seen = "2026-01-03T00:00:00Z";
    expect(runsLight([run("failed", "2026-01-02T00:00:00Z")], seen)).toBe("gray");
    expect(runsLight([run("failed", "2026-01-04T00:00:00Z")], seen)).toBe("red");
    expect(runsLight([run("cancelled", "2026-01-04T00:00:00Z")], seen)).toBe("gray");
  });
});

describe("workspaceLight", () => {
  it("combines todos and run attention, worst wins", () => {
    expect(workspaceLight([], [], null)).toBe("gray");
    expect(workspaceLight([todo({ light: "yellow" })], [run("running")], null)).toBe("yellow");
    expect(
      workspaceLight([todo({ light: "yellow" })], [run("failed", "2026-01-02T00:00:00Z")], null),
    ).toBe("red");
  });
});
