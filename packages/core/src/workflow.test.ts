import { describe, expect, it } from "vitest";
import { createAgentRun } from "./agent.js";
import {
  STANDARD_WORKFLOW_TEMPLATE,
  addTrack,
  budgetState,
  buildWorkflowManagerPrompt,
  createWorkflow,
  duplicateTemplate,
  formatUserMessage,
  isCustomTemplateId,
  setStageStatus,
  stagePurpose,
  templateOf,
  validateWorkflowTemplate,
  workflowIdOfRun,
  workflowSpend,
  workflowStatusText,
  workflowTag,
  workflowTemplate,
  type WorkflowTemplate,
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

/** A small custom template: a → b ∥ c → d. */
function customTemplate(): WorkflowTemplate {
  return {
    id: "wft_custom",
    name: "Docs pass",
    stages: [
      { id: "a", name: "Survey", purpose: "survey", dependsOn: [], perTrack: false, description: "look" },
      { id: "b", name: "Write", purpose: "implement", dependsOn: ["a"], perTrack: true, description: "write", model: "opus" },
      { id: "c", name: "Review", purpose: "code-review", dependsOn: ["a"], perTrack: true, description: "check" },
      { id: "d", name: "Publish", purpose: "release", dependsOn: ["b", "c"], perTrack: false, description: "ship" },
    ],
  };
}

describe("template validation and authoring", () => {
  it("built-in templates validate clean", () => {
    expect(validateWorkflowTemplate(STANDARD_WORKFLOW_TEMPLATE)).toEqual([]);
    expect(validateWorkflowTemplate(customTemplate())).toEqual([]);
  });

  it("flags empty names, missing stages, duplicate ids and unknown deps", () => {
    expect(validateWorkflowTemplate({ id: "wft_x", name: " ", stages: [] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/name/), expect.stringMatching(/at least one stage/)]),
    );
    const t = customTemplate();
    t.stages.push({ ...t.stages[0]! });
    expect(validateWorkflowTemplate(t).join(" ")).toMatch(/Duplicate stage id: a/);
    const u = customTemplate();
    u.stages[3]!.dependsOn = ["b", "ghost"];
    expect(validateWorkflowTemplate(u).join(" ")).toMatch(/unknown stage: ghost/);
    const s = customTemplate();
    s.stages[0]!.dependsOn = ["a"];
    expect(validateWorkflowTemplate(s).join(" ")).toMatch(/depends on itself/);
  });

  it("detects dependency cycles", () => {
    const t = customTemplate();
    t.stages[0]!.dependsOn = ["d"]; // a → d → {b,c} → a
    expect(validateWorkflowTemplate(t).join(" ")).toMatch(/cycle/i);
  });

  it("duplicateTemplate mints an editable custom copy", () => {
    const copy = duplicateTemplate(STANDARD_WORKFLOW_TEMPLATE);
    expect(isCustomTemplateId(copy.id)).toBe(true);
    expect(isCustomTemplateId(STANDARD_WORKFLOW_TEMPLATE.id)).toBe(false);
    expect(copy.name).toBe("Standard delivery (copy)");
    expect(copy.stages).toEqual(STANDARD_WORKFLOW_TEMPLATE.stages);
    // Deep copy — mutating the duplicate must not touch the built-in.
    copy.stages[0]!.dependsOn.push("x");
    expect(STANDARD_WORKFLOW_TEMPLATE.stages[0]!.dependsOn).toEqual([]);
  });
});

describe("custom-template workflows", () => {
  it("snapshots the template and runs stages on it", () => {
    const wf = createWorkflow({ name: "Docs", goal: "write docs", template: customTemplate() });
    expect(wf.templateId).toBe("wft_custom");
    expect(templateOf(wf).name).toBe("Docs pass");
    expect(wf.stages.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);

    // Dependency rails come from the snapshot, not the built-in registry.
    expect(setStageStatus(wf, "d", "active").ok).toBe(false);
    const a = setStageStatus(wf, "a", "done");
    expect(a.ok).toBe(true);
    if (a.ok) expect(setStageStatus(a.workflow, "b", "active").ok).toBe(true);

    expect(stagePurpose(wf, "c")).toBe("code-review");
    expect(buildWorkflowManagerPrompt(wf)).toContain("Write (b, per track, model: opus)");
  });

  it("rejects invalid templates at creation", () => {
    const bad = customTemplate();
    bad.stages[0]!.dependsOn = ["d"];
    expect(() => createWorkflow({ name: "X", goal: "g", template: bad })).toThrow(/cycle/i);
  });

  it("workflows without a snapshot resolve built-ins by id", () => {
    const wf = makeWorkflow();
    expect(wf.template ?? null).toBeNull();
    expect(templateOf(wf).id).toBe("standard");
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
