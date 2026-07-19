import { describe, expect, it } from "vitest";
import { createAgentRun } from "./agent.js";
import {
  STANDARD_WORKFLOW_TEMPLATE,
  addTrack,
  budgetState,
  buildWorkflowManagerPrompt,
  createWorkflow,
  formatUserMessage,
  setStageStatus,
  workflowIdOfRun,
  workflowSpend,
  workflowStatusText,
  workflowTag,
  workflowTemplate,
} from "./workflow.js";

function makeWorkflow(budgetUsd: number | null = null) {
  return createWorkflow({ name: "Payments v2", goal: "Ship payments", budgetUsd });
}

describe("workflow template", () => {
  it("standard template stage graph is well-formed", () => {
    const ids = new Set(STANDARD_WORKFLOW_TEMPLATE.stages.map((s) => s.id));
    expect(ids.size).toBe(STANDARD_WORKFLOW_TEMPLATE.stages.length);
    for (const stage of STANDARD_WORKFLOW_TEMPLATE.stages) {
      for (const dep of stage.dependsOn) expect(ids.has(dep)).toBe(true);
    }
    // The canonical shape: refine → plan ∥ design → develop ∥ review → merge → release.
    const byId = new Map(STANDARD_WORKFLOW_TEMPLATE.stages.map((s) => [s.id, s]));
    expect(byId.get("plan")!.dependsOn).toEqual(["refine"]);
    expect(byId.get("design")!.dependsOn).toEqual(["refine"]);
    expect(byId.get("develop")!.perTrack).toBe(true);
    expect(byId.get("review")!.perTrack).toBe(true);
    expect(byId.get("merge")!.dependsOn).toEqual(expect.arrayContaining(["develop", "review"]));
    expect(byId.get("release")!.dependsOn).toEqual(["merge"]);
    // Cost routing: heavyweight models only where code gets written.
    expect(byId.get("develop")!.model).toBe("opus");
    expect(byId.get("merge")!.model).toBe("opus");
    expect(byId.get("plan")!.model).toBe("sonnet");
    expect(byId.get("review")!.model).toBe("sonnet");
  });

  it("unknown template ids fall back to standard", () => {
    expect(workflowTemplate("nope").id).toBe("standard");
  });
});

describe("workflow instances", () => {
  it("seeds one pending stage state per template stage", () => {
    const wf = makeWorkflow();
    expect(wf.stages.map((s) => s.id)).toEqual(
      STANDARD_WORKFLOW_TEMPLATE.stages.map((s) => s.id),
    );
    expect(wf.stages.every((s) => s.status === "pending")).toBe(true);
    expect(wf.status).toBe("running");
  });

  it("enforces stage dependencies on activation", () => {
    const wf = makeWorkflow();
    // develop needs plan + design done.
    const blocked = setStageStatus(wf, "develop", "active");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/plan/);

    let cur = wf;
    for (const [stage, status] of [
      ["refine", "done"],
      ["plan", "done"],
      ["design", "skipped"], // skipped satisfies dependents
    ] as const) {
      const r = setStageStatus(cur, stage, status);
      expect(r.ok).toBe(true);
      if (r.ok) cur = r.workflow;
    }
    const develop = setStageStatus(cur, "develop", "active");
    expect(develop.ok).toBe(true);
    if (develop.ok) {
      const state = develop.workflow.stages.find((s) => s.id === "develop")!;
      expect(state.status).toBe("active");
      expect(state.startedAt).toBeTruthy();
    }
    // The input workflow is never mutated.
    expect(wf.stages.every((s) => s.status === "pending")).toBe(true);
  });

  it("rejects unknown stages", () => {
    const r = setStageStatus(makeWorkflow(), "shipit", "active");
    expect(r.ok).toBe(false);
  });

  it("adds tracks with slugged default branches", () => {
    const wf = makeWorkflow();
    const { workflow, track } = addTrack(wf, { name: "API layer" });
    expect(track.branch).toBe("wf/payments-v2/api-layer");
    expect(workflow.tracks).toHaveLength(1);
    const { track: custom } = addTrack(workflow, { name: "UI", branch: "feat/ui" });
    expect(custom.branch).toBe("feat/ui");
  });
});

describe("workflow cost accounting", () => {
  const wf = makeWorkflow(1.0);
  const tag = workflowTag(wf.id);

  function run(costUsd: number | null, status: "completed" | "running", tags = [tag]) {
    const r = createAgentRun({ prompt: "x", tags });
    r.status = status;
    r.costUsd = costUsd;
    r.usage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      apiCalls: 1,
    };
    r.model = "claude-sonnet-5";
    return r;
  }

  it("tags identify a run's workflow", () => {
    expect(workflowIdOfRun(run(0, "completed"))).toBe(wf.id);
    expect(workflowIdOfRun(createAgentRun({ prompt: "x" }))).toBeNull();
  });

  it("sums attributed runs only, estimating live runs from usage", () => {
    const runs = [
      run(0.6, "completed"),
      run(null, "running"), // estimated from usage at sonnet prices
      run(5, "completed", ["other"]), // not this workflow
    ];
    const spend = workflowSpend(wf.id, runs);
    expect(spend.runCount).toBe(2);
    expect(spend.liveRunCount).toBe(1);
    expect(spend.totalTokens).toBe(3000);
    // 0.6 + (1000*3 + 500*15)/1e6 = 0.6105
    expect(spend.costUsd).toBeCloseTo(0.6105, 4);
  });

  it("budget state flags exhaustion", () => {
    const under = budgetState(wf, { totalTokens: 0, costUsd: 0.5, runCount: 1, liveRunCount: 0 });
    expect(under.exhausted).toBe(false);
    expect(under.remainingUsd).toBeCloseTo(0.5, 5);
    const overSpend = { totalTokens: 0, costUsd: 1.2, runCount: 3, liveRunCount: 0 };
    expect(budgetState(wf, overSpend).exhausted).toBe(true);
    const unlimited = budgetState(makeWorkflow(null), overSpend);
    expect(unlimited.exhausted).toBe(false);
    expect(unlimited.remainingUsd).toBeNull();
  });

  it("status text shows stages, tracks and spend vs budget", () => {
    const { workflow } = addTrack(wf, { name: "API" });
    const text = workflowStatusText(workflow, {
      totalTokens: 42_000,
      costUsd: 1.5,
      runCount: 4,
      liveRunCount: 1,
    });
    expect(text).toContain("refine [pending]");
    expect(text).toContain("wf/payments-v2/api");
    expect(text).toContain("$1.50");
    expect(text).toContain("EXHAUSTED");
  });
});

describe("manager prompting", () => {
  it("kickoff prompt covers the protocol: stages, board, budget, remote control", () => {
    const wf = makeWorkflow(25);
    const prompt = buildWorkflowManagerPrompt(wf);
    expect(prompt).toContain(wf.id);
    expect(prompt).toContain("Ship payments");
    expect(prompt).toContain("$25.00");
    for (const s of STANDARD_WORKFLOW_TEMPLATE.stages) expect(prompt).toContain(s.id);
    expect(prompt).toContain("USER MESSAGE");
    expect(prompt).toContain("complete_workflow");
    expect(prompt).toContain("add_track");
    expect(prompt).toContain("worktree");
    expect(prompt).toContain("Model routing");
    expect(prompt).toContain("model: opus");
  });

  it("user messages are framed as steering", () => {
    const text = formatUserMessage("Drop the release stage.");
    expect(text).toMatch(/^USER MESSAGE:/);
    expect(text).toContain("Drop the release stage.");
  });
});
