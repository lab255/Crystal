import { describe, expect, it } from "vitest";
import { createAgentRun } from "./agent.js";
import { AgentProfileSchema } from "./agent-profile.js";
import { createTask, createTaskQuestion } from "./project.js";
import type { EnvReport } from "./preflight.js";
import {
  ADVANCED_WORKFLOW_TEMPLATE,
  STALL_TURN_LIMIT,
  SIMPLE_WORKFLOW_TEMPLATE,
  STAGE_ARCHETYPES,
  STANDARD_WORKFLOW_TEMPLATE,
  TURN_LOG_LIMIT,
  WORKFLOW_TEMPLATES,
  WorkflowSchema,
  activeBoardStatuses,
  addTrack,
  appendTurnLog,
  boardColumnStages,
  budgetState,
  buildWorkflowManagerPrompt,
  createWorkflow,
  deriveTemplate,
  duplicateTemplate,
  formatUserMessage,
  isCustomTemplateId,
  isEditableTemplate,
  makeTemplate,
  setStageStatus,
  stageBoardStatus,
  stageFromArchetype,
  stagePurpose,
  tailStageId,
  templateOf,
  templateScope,
  templateWarnings,
  validateWorkflowTemplate,
  workflowIdOfRun,
  workflowProgressFingerprint,
  workflowSpend,
  workflowStatusText,
  workflowTag,
  workflowTemplate,
  type Workflow,
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
  return makeTemplate({
    id: "wft_custom",
    name: "Docs pass",
    stages: [
      { id: "a", name: "Survey", purpose: "survey", dependsOn: [], perTrack: false, description: "look" },
      { id: "b", name: "Write", purpose: "implement", dependsOn: ["a"], perTrack: true, description: "write", model: "opus" },
      { id: "c", name: "Review", purpose: "code-review", dependsOn: ["a"], perTrack: true, description: "check" },
      { id: "d", name: "Publish", purpose: "release", dependsOn: ["b", "c"], perTrack: false, description: "ship" },
    ],
  });
}

describe("template validation and authoring", () => {
  it("built-in templates validate clean", () => {
    expect(validateWorkflowTemplate(STANDARD_WORKFLOW_TEMPLATE)).toEqual([]);
    expect(validateWorkflowTemplate(customTemplate())).toEqual([]);
  });

  it("flags empty names, missing stages, duplicate ids and unknown deps", () => {
    expect(validateWorkflowTemplate(makeTemplate({ id: "wft_x", name: " ", stages: [] }))).toEqual(
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

  it("does not mistake duplicate dependency edges for a cycle", () => {
    const t = customTemplate();
    t.stages[1]!.dependsOn = ["a", "a"];
    expect(validateWorkflowTemplate(t)).toEqual([]);
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

  it("disambiguates default branches and rejects explicit branch reuse", () => {
    const wf = makeWorkflow();
    const first = addTrack(wf, { name: "API layer" });
    const second = addTrack(first.workflow, { name: "API layer" });
    expect(first.track.branch).toBe("wf/payments-v2/api-layer");
    expect(second.track.branch).toBe("wf/payments-v2/api-layer-2");

    expect(() =>
      addTrack(second.workflow, { name: "Other", branch: first.track.branch }),
    ).toThrow(/branch is already in use/i);

    const duplicate = {
      ...second.workflow,
      tracks: second.workflow.tracks.map((track, index) =>
        index === 1 ? { ...track, branch: first.track.branch } : track,
      ),
    };
    expect(WorkflowSchema.safeParse(duplicate).success).toBe(false);
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

  it("tolerates run records predating the tags field", () => {
    // Regression: a single legacy run without `tags` crashed workflowSpend
    // (`r.tags.includes`), which took workflow_status down with it — a
    // manager mid-workflow lost its spend meter entirely.
    const legacy = run(0.5, "completed");
    (legacy as { tags?: string[] }).tags = undefined;
    const spend = workflowSpend(wf.id, [legacy, run(0.6, "completed")]);
    expect(spend.runCount).toBe(1); // the legacy run reads as unattributed
    expect(workflowIdOfRun(legacy)).toBeNull();
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
    expect(prompt).toContain("Agent routing");
    expect(prompt).toContain("model: opus");
  });

  it("renders the agent roster so dispatch is a lookup by agentId", () => {
    const roster = [
      AgentProfileSchema.parse({
        id: "agent_sec",
        name: "Security reviewer",
        kind: "specialist",
        model: "sonnet",
        appendPrompt: "Only review; never edit.",
      }),
    ];
    const prompt = buildWorkflowManagerPrompt(makeWorkflow(), roster);
    expect(prompt).toContain("Agent roster");
    expect(prompt).toContain('- agent_sec "Security reviewer" · specialist · model sonnet');
    expect(prompt).toContain("standing: Only review; never edit.");
    // No roster = no empty section header.
    expect(buildWorkflowManagerPrompt(makeWorkflow())).not.toContain("Agent roster");
  });

  it("a stage naming an agentId surfaces it in the stage list", () => {
    const wf = createWorkflow({
      name: "X",
      goal: "g",
      template: makeTemplate({
        id: "wft_agents",
        name: "With agents",
        stages: [
          { id: "audit", name: "Audit", purpose: "security-review", agentId: "agent_sec" },
        ],
      }),
    });
    expect(buildWorkflowManagerPrompt(wf)).toContain("agent: agent_sec");
  });

  it("user messages are framed as steering", () => {
    const text = formatUserMessage("Drop the release stage.");
    expect(text).toMatch(/^USER MESSAGE:/);
    expect(text).toContain("Drop the release stage.");
  });

  it("names each stage's handoff, and what its dependents receive", () => {
    const prompt = buildWorkflowManagerPrompt(makeWorkflow());
    const plan = STANDARD_WORKFLOW_TEMPLATE.stages.find((s) => s.id === "plan")!;
    expect(prompt).toContain(`Hands off: ${plan.handoff}`);
    // develop depends on plan + design, so it is told what both owe it.
    expect(prompt).toMatch(new RegExp(`Receives:.*plan → ${escapeRe(plan.handoff)}`));
    expect(prompt).toContain("Every dispatch is a HANDOFF");
  });

  it("renders the stage → board column mapping the template declares", () => {
    const prompt = buildWorkflowManagerPrompt(makeWorkflow());
    expect(prompt).toContain("- backlog: plan, design");
    expect(prompt).toContain("- in_progress: develop");
    expect(prompt).toContain("- review: review");
    expect(prompt).toContain("- done: merge, release");
    // The coordination-only stage claims no column.
    expect(prompt).not.toMatch(/^- \w+: .*\brefine\b/m);
  });

  /**
   * The protocol used to be a fixed script naming the standard template's
   * stage ids, which quietly misdirected every other graph.
   */
  it("the protocol names the template's own stages, not the standard ones", () => {
    const simple = createWorkflow({ name: "Small", goal: "g", templateId: "simple" });
    const prompt = buildWorkflowManagerPrompt(simple);
    expect(prompt).toContain("build");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("ship");
    // Stage ids the simple template does not have must not be instructed on.
    expect(prompt).not.toContain("develop");
    expect(prompt).not.toContain("add_track"); // no per-track stage in this one

    const advanced = createWorkflow({ name: "Big", goal: "g", templateId: "advanced" });
    const advancedPrompt = buildWorkflowManagerPrompt(advanced);
    expect(advancedPrompt).toContain("add_track");
    expect(advancedPrompt).toContain("research");
    expect(advancedPrompt).toContain("gate");
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("built-in template set", () => {
  it("simple and advanced are valid, warning-free graphs", () => {
    for (const template of Object.values(WORKFLOW_TEMPLATES)) {
      expect(validateWorkflowTemplate(template)).toEqual([]);
      expect(templateWarnings(template)).toEqual([]);
      expect(templateScope(template)).toBe("builtin");
      expect(isEditableTemplate(template)).toBe(false);
    }
  });

  it("simple is a strictly linear chain; advanced fans out and back in", () => {
    // Exactly one root and no stage feeding two others: the artifact handed
    // forward is unambiguous, which is the whole claim of the simple shape.
    const roots = SIMPLE_WORKFLOW_TEMPLATE.stages.filter((s) => s.dependsOn.length === 0);
    expect(roots).toHaveLength(1);
    for (const stage of SIMPLE_WORKFLOW_TEMPLATE.stages) {
      expect(stage.dependsOn.length).toBeLessThanOrEqual(1);
    }
    expect(SIMPLE_WORKFLOW_TEMPLATE.stages.some((s) => s.perTrack)).toBe(false);

    const advanced = ADVANCED_WORKFLOW_TEMPLATE.stages;
    expect(advanced.some((s) => s.perTrack)).toBe(true);
    // Three independent checks all gate the release.
    expect(advanced.find((s) => s.id === "merge")!.dependsOn).toEqual(["review", "security"]);
    expect(advanced.find((s) => s.id === "release")!.dependsOn).toEqual(["gate"]);
  });

  it("every stage that feeds another declares a handoff", () => {
    for (const template of Object.values(WORKFLOW_TEMPLATES)) {
      const consumed = new Set(template.stages.flatMap((s) => s.dependsOn));
      for (const stage of template.stages) {
        if (consumed.has(stage.id)) expect(stage.handoff).not.toBe("");
      }
    }
  });
});

describe("stage graph ↔ board", () => {
  it("maps columns to the stages that feed them, both directions", () => {
    const columns = boardColumnStages(STANDARD_WORKFLOW_TEMPLATE);
    expect(columns.backlog.map((s) => s.id)).toEqual(["plan", "design"]);
    expect(columns.done.map((s) => s.id)).toEqual(["merge", "release"]);
    expect(stageBoardStatus(STANDARD_WORKFLOW_TEMPLATE, "develop")).toBe("in_progress");
    // Coordination-only stages own no column.
    expect(stageBoardStatus(STANDARD_WORKFLOW_TEMPLATE, "refine")).toBeNull();
    expect(stageBoardStatus(STANDARD_WORKFLOW_TEMPLATE, "ghost")).toBeNull();
  });

  it("active columns follow live stage state, not the template", () => {
    const wf = makeWorkflow();
    expect(activeBoardStatuses(wf).size).toBe(0);

    const refining = setStageStatus(wf, "refine", "active");
    expect(refining.ok).toBe(true);
    // refine is active but maps to no column — nothing lights up.
    expect(activeBoardStatuses(refining.ok ? refining.workflow : wf).size).toBe(0);

    let live = refining.ok ? refining.workflow : wf;
    live = expectOk(setStageStatus(live, "refine", "done"));
    live = expectOk(setStageStatus(live, "plan", "active"));
    expect([...activeBoardStatuses(live)]).toEqual(["backlog"]);
  });

  it("warns about handoff gaps without blocking the save", () => {
    const t = customTemplate();
    t.stages[0]!.handoff = "";
    // a feeds b and c, so its silence is worth flagging — but it is still a
    // valid graph: half-finished is normal in a visual builder.
    expect(validateWorkflowTemplate(t)).toEqual([]);
    expect(templateWarnings(t).join(" ")).toMatch(/feeds another stage but declares no handoff/);
  });
});

describe("template scoping and derivation", () => {
  it("derives an independent project copy, recording provenance", () => {
    const derived = deriveTemplate(STANDARD_WORKFLOW_TEMPLATE, { scope: "project" });
    expect(derived.id).toMatch(/^wft_/);
    expect(derived.scope).toBe("project");
    expect(derived.basedOn).toBe("standard");
    expect(isEditableTemplate(derived)).toBe(true);

    // Independent: editing the copy must not reach the built-in.
    derived.stages[0]!.name = "Renamed";
    derived.stages[1]!.dependsOn.push("release");
    expect(STANDARD_WORKFLOW_TEMPLATE.stages[0]!.name).toBe("Refine");
    expect(STANDARD_WORKFLOW_TEMPLATE.stages[1]!.dependsOn).toEqual(["refine"]);
  });

  it("scope is read from the built-in registry, not a record's own claim", () => {
    // A hand-edited file claiming to be built-in must not become read-only.
    const liar = makeTemplate({ ...customTemplate(), scope: "builtin" });
    expect(templateScope(liar)).toBe("project");
    expect(isEditableTemplate(liar)).toBe(true);
    // ...and a built-in id stays built-in whatever the record says.
    expect(templateScope(makeTemplate({ ...STANDARD_WORKFLOW_TEMPLATE, scope: "project" }))).toBe(
      "builtin",
    );
  });

  it("archetypes drop as fully-formed stages with unique ids", () => {
    const review = STAGE_ARCHETYPES.find((a) => a.key === "review")!;
    const first = stageFromArchetype(review, [], { x: 40, y: 12 });
    expect(first.id).toBe("review");
    expect(first.boardStatus).toBe("review");
    expect(first.handoff).not.toBe("");
    expect({ x: first.x, y: first.y }).toEqual({ x: 40, y: 12 });

    // A second one of the same kind must not collide — ids are the handle
    // every dependsOn and the manager's prompt use.
    const second = stageFromArchetype(review, [first.id]);
    expect(second.id).toBe("review-2");
    expect(stageFromArchetype(review, [first.id, second.id]).id).toBe("review-3");
  });

  it("tailStageId finds the deepest stage, later insertion breaking ties", () => {
    expect(tailStageId([])).toBeNull();
    // Linear chain: the last stage is the tail wherever it sits in the array.
    expect(tailStageId(SIMPLE_WORKFLOW_TEMPLATE.stages)).toBe(
      SIMPLE_WORKFLOW_TEMPLATE.stages[SIMPLE_WORKFLOW_TEMPLATE.stages.length - 1]!.id,
    );
    // a → b ∥ c → d: d is deepest.
    expect(tailStageId(customTemplate().stages)).toBe("d");
    // Two leaves at the same depth: the later-inserted one wins — that is the
    // stage the author most recently added, so click-to-add chains from it.
    const t = makeTemplate({
      id: "wft_tie",
      name: "Tie",
      stages: [
        { id: "root", name: "Root", purpose: "plan", dependsOn: [], perTrack: false, description: "r" },
        { id: "left", name: "Left", purpose: "implement", dependsOn: ["root"], perTrack: false, description: "l" },
        { id: "right", name: "Right", purpose: "implement", dependsOn: ["root"], perTrack: false, description: "r" },
      ],
    });
    expect(tailStageId(t.stages)).toBe("right");
    // Depth beats array position: a deep stage early in the array still wins.
    const shuffled = makeTemplate({
      id: "wft_shuffled",
      name: "Shuffled",
      stages: [
        { id: "end", name: "End", purpose: "release", dependsOn: ["mid"], perTrack: false, description: "e" },
        { id: "mid", name: "Mid", purpose: "implement", dependsOn: ["start"], perTrack: false, description: "m" },
        { id: "start", name: "Start", purpose: "plan", dependsOn: [], perTrack: false, description: "s" },
      ],
    });
    expect(tailStageId(shuffled.stages)).toBe("end");
    // A cycle must not hang or throw — validation reports it; tail is best-effort.
    const cyclic = makeTemplate({
      id: "wft_cycle",
      name: "Cycle",
      stages: [
        { id: "a", name: "A", purpose: "plan", dependsOn: ["b"], perTrack: false, description: "a" },
        { id: "b", name: "B", purpose: "plan", dependsOn: ["a"], perTrack: false, description: "b" },
      ],
    });
    expect(typeof tailStageId(cyclic.stages)).toBe("string");
  });

  it("a custom template's persisted positions survive a round-trip", () => {
    const t = customTemplate();
    t.stages[0]!.x = 120;
    t.stages[0]!.y = -40;
    const parsed = makeTemplate(JSON.parse(JSON.stringify(t)));
    expect(parsed.stages[0]!.x).toBe(120);
    expect(parsed.stages[0]!.y).toBe(-40);
    // Stages never dragged stay unpositioned, so auto-layout still owns them.
    expect(parsed.stages[1]!.x ?? null).toBeNull();
  });
});

function expectOk(transition: ReturnType<typeof setStageStatus>): Workflow {
  if (!transition.ok) throw new Error(transition.reason);
  return transition.workflow;
}

describe("typed turn outcomes (progress fingerprint)", () => {
  it("is stable across turns that settle nothing, and moves with every kind of progress", () => {
    const wf = makeWorkflow();
    const base = workflowProgressFingerprint(wf, 0, []);
    // Timestamps are not progress — only the typed outcomes are.
    expect(workflowProgressFingerprint({ ...wf, updatedAt: "2099-01-01" }, 0, [])).toBe(base);

    // A dispatch is progress.
    expect(workflowProgressFingerprint(wf, 1, [])).not.toBe(base);
    // A stage transition is progress.
    const advanced = expectOk(setStageStatus(wf, "refine", "done", "settled"));
    expect(workflowProgressFingerprint(advanced, 0, [])).not.toBe(base);
    // Completion is progress.
    expect(workflowProgressFingerprint({ ...wf, status: "completed" as const }, 0, [])).not.toBe(
      base,
    );
  });

  it("sees only the workflow's own board tasks, including their open questions", () => {
    const wf = { ...makeWorkflow(), epicId: "epic_1" };
    const mine = { ...createTask("mine"), epicId: "epic_1" };
    const other = { ...createTask("other"), epicId: "epic_2" };
    const base = workflowProgressFingerprint(wf, 0, [mine, other]);

    // Someone else's board movement is not this workflow's progress.
    expect(
      workflowProgressFingerprint(wf, 0, [mine, { ...other, status: "done" as const }]),
    ).toBe(base);
    // Its own task moving is.
    expect(
      workflowProgressFingerprint(wf, 0, [{ ...mine, status: "in_progress" as const }, other]),
    ).not.toBe(base);
    // Raising (or answering) a question on its task is.
    const asked = { ...mine, questions: [createTaskQuestion("which auth provider?")] };
    const withQuestion = workflowProgressFingerprint(wf, 0, [asked, other]);
    expect(withQuestion).not.toBe(base);
    const answered = {
      ...asked,
      questions: [{ ...asked.questions[0]!, answer: "keycloak" }],
    };
    expect(workflowProgressFingerprint(wf, 0, [answered, other])).not.toBe(withQuestion);
    // An expired closure (closed without an answer) reads as closed the same
    // way — an expiry sweep moves the fingerprint exactly like an answer.
    const expired = {
      ...asked,
      questions: [
        {
          ...asked.questions[0]!,
          closed: { at: "t", reason: "expired" as const, note: null, by: "system" as const },
        },
      ],
    };
    expect(workflowProgressFingerprint(wf, 0, [expired, other])).not.toBe(withQuestion);
    expect(workflowProgressFingerprint(wf, 0, [expired, other])).toBe(
      workflowProgressFingerprint(wf, 0, [answered, other]),
    );
  });

  it("the manager prompt states the typed-outcome contract", () => {
    const prompt = buildWorkflowManagerPrompt(makeWorkflow());
    expect(prompt).toContain("Every turn must end TYPED");
    expect(prompt).toContain(`${STALL_TURN_LIMIT} consecutive turns`);
  });
});

describe("pre-flight report on the workflow", () => {
  const gapReport: EnvReport = {
    checkedAt: "2026-07-29T00:00:00.000Z",
    ok: false,
    checks: [
      { id: "git", label: "git", bins: ["git"], reason: "always", ok: true, resolved: "/usr/bin/git" },
      { id: "pnpm", label: "pnpm", bins: ["pnpm"], reason: "pnpm-lock.yaml", ok: false, resolved: null },
    ],
  };

  it("gaps land in the kickoff prompt with the ask-first instruction", () => {
    const wf = { ...makeWorkflow(), env: gapReport };
    const prompt = buildWorkflowManagerPrompt(wf);
    expect(prompt).toContain("ENVIRONMENT GAPS");
    expect(prompt).toContain("pnpm (expected because pnpm-lock.yaml)");
    // A clean environment injects nothing.
    expect(buildWorkflowManagerPrompt({ ...wf, env: { ...gapReport, ok: true, checks: [] } })).not.toContain(
      "ENVIRONMENT GAPS",
    );
  });

  it("gaps stay visible in workflow_status, many turns after the kickoff", () => {
    const wf = { ...makeWorkflow(), env: gapReport };
    const spend = workflowSpend(wf.id, []);
    expect(workflowStatusText(wf, spend)).toContain("Environment gaps: pnpm missing (pnpm-lock.yaml)");
    expect(workflowStatusText(makeWorkflow(), spend)).not.toContain("Environment gaps");
  });
});

describe("premise report on the workflow", () => {
  const failedPremise = {
    checkedAt: "2026-07-29T00:00:00.000Z",
    ok: false,
    checks: [
      {
        kind: "branch" as const,
        arg: "release/2.3",
        raw: "assert: branch release/2.3",
        ok: false,
        detail: "no such local or origin branch",
      },
    ],
  };

  it("failed claims land in the kickoff prompt with the stop-and-ask instruction", () => {
    const wf = { ...makeWorkflow(), premise: failedPremise };
    const prompt = buildWorkflowManagerPrompt(wf);
    expect(prompt).toContain("FAILED PREMISES");
    expect(prompt).toContain("assert: branch release/2.3");
    expect(buildWorkflowManagerPrompt(makeWorkflow())).not.toContain("FAILED PREMISES");
  });

  it("failed claims stay visible in workflow_status", () => {
    const wf = { ...makeWorkflow(), premise: failedPremise };
    const spend = workflowSpend(wf.id, []);
    expect(workflowStatusText(wf, spend)).toContain(
      "Failed premises: assert: branch release/2.3 (no such local or origin branch)",
    );
    expect(workflowStatusText(makeWorkflow(), spend)).not.toContain("Failed premises");
  });
});

describe("per-run cost cap", () => {
  it("createWorkflow carries the cap and the prompt/status render it", () => {
    const wf = createWorkflow({
      name: "Capped",
      goal: "Ship it",
      budgetUsd: 20,
      runCapUsd: 1.5,
    });
    expect(wf.runCapUsd).toBe(1.5);
    expect(buildWorkflowManagerPrompt(wf)).toContain("hard-capped at $1.50");
    expect(workflowStatusText(wf, workflowSpend(wf.id, []))).toContain("per-run cap $1.50");
    // Uncapped workflows say nothing about caps.
    expect(buildWorkflowManagerPrompt(makeWorkflow())).not.toContain("hard-capped");
  });
});

describe("marginal-value turn log", () => {
  it("appendTurnLog keeps newest-last and bounds the length", () => {
    let log: ReturnType<typeof createWorkflow>["turnLog"] = [];
    for (let i = 0; i < TURN_LOG_LIMIT + 5; i += 1) {
      log = appendTurnLog(log, {
        runId: `run_${i}`,
        at: `t${String(i).padStart(3, "0")}`,
        costUsd: 0.1,
        progressed: i % 2 === 0,
      });
    }
    expect(log).toHaveLength(TURN_LOG_LIMIT);
    expect(log[0]!.runId).toBe("run_5");
    expect(log[log.length - 1]!.runId).toBe(`run_${TURN_LOG_LIMIT + 4}`);
  });
});
