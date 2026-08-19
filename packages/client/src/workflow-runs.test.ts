import { describe, expect, it } from "vitest";
import { createAgentRun, type AgentRun } from "@crystal/core";
import { workflowRunForest } from "./workflow-runs.js";

const workflowTag = "workflow:wanted";

function run(
  prompt: string,
  init: Parameters<typeof createAgentRun>[0] = { prompt },
): AgentRun {
  return createAgentRun({ ...init, prompt });
}

describe("workflowRunForest", () => {
  it("keeps a tag from the first turn when a manager resumes", () => {
    const first = run("manager first", { prompt: "manager first", role: "manager", tags: [workflowTag] });
    const resumed = run("manager resumed", {
      prompt: "manager resumed",
      role: "manager",
      resumedFromRunId: first.id,
    });

    const forest = workflowRunForest([resumed, first], "wanted");
    expect(forest.map((node) => node.run.id)).toEqual([resumed.id]);
    expect(forest[0]?.turns.map((turn) => turn.id)).toEqual([first.id, resumed.id]);
  });

  it("nests a worker-manager and its worker", () => {
    const manager = run("manager", { prompt: "manager", role: "manager", tags: [workflowTag] });
    const workerManager = run("worker manager", {
      prompt: "worker manager",
      role: "manager",
      parentRunId: manager.id,
      tags: [workflowTag],
    });
    const worker = run("leaf", {
      prompt: "leaf",
      parentRunId: workerManager.id,
      tags: [workflowTag],
    });

    // One root only: nested matches stay nested, never also promoted.
    const forest = workflowRunForest([worker, workerManager, manager], "wanted");
    expect(forest.map((node) => node.run.id)).toEqual([manager.id]);
    expect(forest[0]?.workers[0]?.run.id).toBe(workerManager.id);
    expect(forest[0]?.workers[0]?.workers[0]?.run.id).toBe(worker.id);
  });

  it("sorts the manager chain first even when a promoted chain precedes it", () => {
    const untagged = run("legacy manager", { prompt: "legacy manager", role: "manager" });
    const promoted = run("stray worker", {
      prompt: "stray worker",
      parentRunId: untagged.id,
      tags: [workflowTag],
    });
    const manager = run("real manager", {
      prompt: "real manager",
      role: "manager",
      tags: [workflowTag],
    });

    const forest = workflowRunForest([promoted, untagged, manager], "wanted");
    expect(forest.map((node) => node.run.id)).toEqual([manager.id, promoted.id]);
  });

  it("excludes unrelated sessions and promotes a tagged chain below an untagged manager", () => {
    const untagged = run("legacy manager", { prompt: "legacy manager", role: "manager" });
    const promoted = run("workflow worker", {
      prompt: "workflow worker",
      parentRunId: untagged.id,
      tags: [workflowTag],
    });
    const unrelated = run("other", {
      prompt: "other",
      role: "manager",
      tags: ["workflow:other"],
    });

    const forest = workflowRunForest([unrelated, promoted, untagged], "wanted");
    expect(forest.map((node) => node.run.id)).toEqual([promoted.id]);
  });
});
