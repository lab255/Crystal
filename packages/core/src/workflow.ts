import { z } from "zod";
import { nowIso, slugify, uid } from "./ids.js";
import {
  usageTotalTokens,
  RunPurposeSchema,
  type AgentRun,
  type RunPurpose,
} from "./agent.js";
import { rosterText, type AgentProfile, type ModelPreset } from "./agent-profile.js";
import { runCostUsd } from "./orchestration.js";
import { EnvReportSchema, envGapPromptNote, envGaps } from "./preflight.js";
import { PremiseReportSchema, premiseGapPromptNote, premiseGaps } from "./premise.js";
import {
  TASK_STATUSES,
  TaskStatusSchema,
  type TaskItem,
  type TaskQuestion,
  type TaskStatus,
} from "./project.js";

/**
 * Multi-agent workflows — the coordination layer above manager/worker runs.
 *
 * A workflow instantiates a *template* (stage graph) around one long-lived
 * **manager** session: an interactive, resumable Claude run that refines
 * requirements with the user, plans the work onto the board, dispatches
 * workers per stage, accounts for cost against a budget, and drives the work
 * through merge and release. The pure rules live here (templates, stage
 * transitions, track/branch bookkeeping, spend/budget math, the manager's
 * standing prompt); enforcement lives in the server's WorkflowEngine.
 *
 * Attribution: every run belonging to a workflow — the manager chain and all
 * dispatched workers — carries the dimensional tag {@link workflowTag}, so a
 * workflow's spend is derivable from the run list alone, independent of which
 * board tasks the runs billed.
 */

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a stage's board tasks sit while it is the stage doing the work.
 * This is the seam between the two halves of the orchestrator: the workflow
 * graph says *what happens next*, the board says *what state the work is in*,
 * and without a declared mapping the manager has to invent one per template.
 * `null` means the stage owns no board state (a coordination-only stage like
 * refine, which happens before there are tasks to move).
 */
export const StageBoardStatusSchema = TaskStatusSchema.nullish();

/** One stage of a workflow template. */
export const WorkflowStageDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Run purpose stamped on workers dispatched for this stage. */
  purpose: RunPurposeSchema,
  /** Stage ids that must be done (or skipped) before this one activates. */
  dependsOn: z.array(z.string()).default([]),
  /** Stage runs once per parallel track (develop/review) instead of once. */
  perTrack: z.boolean().default(false),
  /** One-line description woven into prompts and shown in the UI. */
  description: z.string().default(""),
  /**
   * Suggested model for this stage's workers — cost routing: heavyweight
   * models where the code is written, lighter ones everywhere else. The
   * manager passes it as dispatch_worker's `model`.
   */
  model: z.string().optional(),
  /**
   * Named agent profile for this stage's workers (see agent-profile.ts) —
   * *who* runs the stage, not just which model. The manager passes it as
   * dispatch_worker's `agentId`; `model` stays as the fallback hint.
   */
  agentId: z.string().optional(),
  /**
   * The **handoff**: what this stage hands to the stages that depend on it,
   * stated as a concrete artifact ("board tasks with acceptance criteria",
   * "a reviewed branch"). Dependencies alone only say *when* a stage may
   * start; the handoff says what the next worker is owed, so it goes into
   * both the producing stage's brief and the consuming stage's context.
   */
  handoff: z.string().default(""),
  /** Board column this stage's tasks occupy while it works. */
  boardStatus: StageBoardStatusSchema,
  /**
   * Canvas position from the builder. Persisted so a hand-arranged graph
   * survives a reload; stages without one fall back to the layered auto
   * layout, which is also what every built-in relies on.
   */
  x: z.number().nullish(),
  y: z.number().nullish(),
});
export type WorkflowStageDef = z.infer<typeof WorkflowStageDefSchema>;

/**
 * Where a template lives, which is also who may edit it:
 *
 * - `builtin` — shipped in {@link WORKFLOW_TEMPLATES}, read-only. Derive to edit.
 * - `global` — the shared library (`~/.crystal/workflow-templates`), visible
 *   from every project. This is the vocabulary the hub dispatches against:
 *   a program splits into deliveries across repos, and they should be able to
 *   name the same shape of work.
 * - `project` — pinned to one workspace, for a shape that only makes sense in
 *   that repo. Never leaks into another project's list.
 */
export const TEMPLATE_SCOPES = ["builtin", "global", "project"] as const;
export const TemplateScopeSchema = z.enum(TEMPLATE_SCOPES);
export type TemplateScope = z.infer<typeof TemplateScopeSchema>;

/**
 * A workflow template: the stage graph a workflow instantiates. Built-ins
 * live in {@link WORKFLOW_TEMPLATES}; custom templates (authored in the
 * visual builder) are persisted server-side and snapshotted into each
 * workflow at start, so editing or deleting a template never corrupts a
 * running instance.
 */
export const WorkflowTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Defaults to `project` so a template persisted before scopes existed keeps
   * exactly the reach it had — per-workspace — instead of silently widening
   * into every project on the next load.
   */
  scope: TemplateScopeSchema.default("project"),
  /** One-line summary for the picker; what this shape of work is for. */
  description: z.string().default(""),
  /**
   * The template this was derived from, if any. Provenance only — a derived
   * template is a full independent copy (that is the point: customising for
   * one project must not reach back into the library) — but it lets the UI
   * say "customised from Standard delivery" and is the anchor for any future
   * re-sync.
   */
  basedOn: z.string().nullish(),
  stages: z.array(WorkflowStageDefSchema),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/**
 * The *authoring* shapes: what you write, before defaults are filled in.
 * Consumers get the parsed form (every field present), which is what makes
 * `stage.handoff` safe to read everywhere — but constructing one by hand
 * would then mean spelling out every default, so authors go through
 * {@link makeTemplate} / {@link makeStage}.
 */
export type WorkflowTemplateInput = z.input<typeof WorkflowTemplateSchema>;
export type WorkflowStageDefInput = z.input<typeof WorkflowStageDefSchema>;

export function makeTemplate(input: WorkflowTemplateInput): WorkflowTemplate {
  return WorkflowTemplateSchema.parse(input);
}

export function makeStage(input: WorkflowStageDefInput): WorkflowStageDef {
  return WorkflowStageDefSchema.parse(input);
}

/** Id prefix marking custom (builder-authored) templates. */
export function isCustomTemplateId(id: string): boolean {
  return id.startsWith("wft_");
}

/**
 * The stage kinds the builder's palette offers, and the defaults each one
 * drops with. Kept here rather than in the builder because these are domain
 * claims, not presentation: that a review stage parks its tasks in the review
 * column, that implementation is where the heavyweight model is worth paying
 * for. A dropped stage is fully formed and editable, never a blank card the
 * user has to fill in from nothing.
 */
export interface StageArchetype {
  /** Palette key, and the stem of the stage id a drop mints. */
  key: string;
  name: string;
  purpose: RunPurpose;
  description: string;
  handoff: string;
  boardStatus: TaskStatus | null;
  model?: string;
  perTrack?: boolean;
}

export const STAGE_ARCHETYPES: StageArchetype[] = [
  {
    key: "refine",
    name: "Refine",
    purpose: "manage",
    description: "Sharpen the goal into concrete, testable requirements with the user.",
    handoff: "A settled requirements list — testable statements, open questions answered.",
    boardStatus: null,
  },
  {
    key: "research",
    name: "Research",
    purpose: "survey",
    description: "Spike the unknowns before committing to a plan.",
    handoff: "A findings note per unknown, each with a recommendation.",
    boardStatus: "backlog",
    model: "sonnet",
  },
  {
    key: "plan",
    name: "Plan",
    purpose: "plan",
    description: "Break the requirements into board tasks with acceptance criteria and ordering.",
    handoff: "Board tasks with acceptance criteria and blockedBy ordering.",
    boardStatus: "backlog",
    model: "sonnet",
  },
  {
    key: "design",
    name: "Design",
    purpose: "design",
    description: "Design the architecture/API/UI surface the plan builds against.",
    handoff: "The contracts the implementation codes against.",
    boardStatus: "backlog",
    model: "sonnet",
  },
  {
    key: "develop",
    name: "Develop",
    purpose: "implement",
    description: "Implement the planned work, committing as each task lands.",
    handoff: "Committed work with its own tests passing.",
    boardStatus: "in_progress",
    model: "opus",
    perTrack: true,
  },
  {
    key: "test",
    name: "Test",
    purpose: "implement",
    description: "Author tests from the acceptance criteria, beside the code they cover.",
    handoff: "Executable acceptance criteria.",
    boardStatus: "in_progress",
    model: "sonnet",
  },
  {
    key: "review",
    name: "Review",
    purpose: "code-review",
    description: "Review the diff against the acceptance criteria; findings loop back as fixes.",
    handoff: "A verdict: approved, or fix tasks handed back.",
    boardStatus: "review",
    model: "sonnet",
  },
  {
    key: "security",
    name: "Security",
    purpose: "security-review",
    description: "Check authz, input handling, secrets and dependencies over the change.",
    handoff: "A security verdict, with anything blocking raised as a task.",
    boardStatus: "review",
    model: "sonnet",
  },
  {
    key: "fix",
    name: "Fix",
    purpose: "fix",
    description: "Work the findings raised by a review or a failing gate.",
    handoff: "The findings closed, committed on the same branch.",
    boardStatus: "in_progress",
    model: "opus",
  },
  {
    key: "merge",
    name: "Merge",
    purpose: "merge",
    description: "Merge into the main line, resolve conflicts, get the suite green.",
    handoff: "One integrated main line, suite green.",
    boardStatus: "done",
    model: "opus",
  },
  {
    key: "gate",
    name: "CI gate",
    purpose: "ci",
    description: "Full suite, typecheck and build on the merged line.",
    handoff: "A green merged line, or fix tasks with the failing output attached.",
    boardStatus: "done",
    model: "sonnet",
  },
  {
    key: "release",
    name: "Release",
    purpose: "release",
    description: "Release chores: changelog, version bump, tags, release notes.",
    handoff: "A tagged release with notes describing what shipped.",
    boardStatus: "done",
    model: "sonnet",
  },
];

/**
 * Materialize a palette archetype as a stage, given the ids already taken.
 * Ids are the stable handle the manager's prompt and every `dependsOn` use,
 * so a second Review stage becomes `review-2` rather than colliding.
 */
export function stageFromArchetype(
  archetype: StageArchetype,
  takenIds: Iterable<string>,
  position?: { x: number; y: number },
): WorkflowStageDef {
  const taken = new Set(takenIds);
  let id = archetype.key;
  for (let n = 2; taken.has(id); n += 1) id = `${archetype.key}-${n}`;
  return makeStage({
    id,
    name: archetype.name,
    purpose: archetype.purpose,
    dependsOn: [],
    perTrack: archetype.perTrack ?? false,
    description: archetype.description,
    handoff: archetype.handoff,
    boardStatus: archetype.boardStatus,
    model: archetype.model,
    x: position?.x,
    y: position?.y,
  });
}

/**
 * A template's scope, trusting the built-in registry over the record's own
 * field: `scope` is persisted data and a hand-edited file could claim
 * anything, but built-in-ness is decided by the id being in the registry.
 */
export function templateScope(template: WorkflowTemplate): TemplateScope {
  if (WORKFLOW_TEMPLATES[template.id]) return "builtin";
  return template.scope === "builtin" ? "project" : template.scope;
}

/** Built-ins are read-only — the builder derives to edit them. */
export function isEditableTemplate(template: WorkflowTemplate): boolean {
  return templateScope(template) !== "builtin";
}

/**
 * Structural validation for builder-authored templates. Returns a list of
 * human-readable problems (empty = valid): a template must have a name and
 * at least one stage, stage ids must be unique and non-empty, dependencies
 * must reference existing stages (no self-deps), and the dependency graph
 * must be acyclic — {@link setStageStatus} walks it as a DAG.
 */
export function validateWorkflowTemplate(template: WorkflowTemplate): string[] {
  const errors: string[] = [];
  if (!template.name.trim()) errors.push("Template needs a name.");
  if (template.stages.length === 0) errors.push("Template needs at least one stage.");

  const ids = new Set<string>();
  for (const stage of template.stages) {
    if (!stage.id.trim()) errors.push("A stage has an empty id.");
    else if (ids.has(stage.id)) errors.push(`Duplicate stage id: ${stage.id}`);
    ids.add(stage.id);
    if (!stage.name.trim()) errors.push(`Stage ${stage.id || "?"} needs a name.`);
  }
  for (const stage of template.stages) {
    for (const dep of stage.dependsOn) {
      if (dep === stage.id) errors.push(`Stage ${stage.id} depends on itself.`);
      else if (!ids.has(dep)) errors.push(`Stage ${stage.id} depends on unknown stage: ${dep}`);
    }
  }

  // Kahn's algorithm — anything left over after peeling roots sits on a cycle.
  const indegree = new Map(template.stages.map((s) => [s.id, 0]));
  for (const stage of template.stages) {
    for (const dep of stage.dependsOn) {
      if (dep !== stage.id && indegree.has(dep)) {
        indegree.set(stage.id, (indegree.get(stage.id) ?? 0) + 1);
      }
    }
  }
  const queue = template.stages.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const stage of template.stages) {
      if (!stage.dependsOn.includes(id) || seen.has(stage.id)) continue;
      const left = (indegree.get(stage.id) ?? 0) - 1;
      indegree.set(stage.id, left);
      if (left <= 0) queue.push(stage.id);
    }
  }
  const cyclic = template.stages.filter((s) => s.id.trim() && !seen.has(s.id));
  if (cyclic.length && ids.size === template.stages.length) {
    errors.push(`Dependency cycle through: ${cyclic.map((s) => s.id).join(", ")}`);
  }
  return errors;
}

/**
 * A builder-editable copy: fresh custom id, deep-cloned stages, provenance
 * recorded in `basedOn`. Deriving is the only way a built-in gets customized
 * (they are read-only), and — with `scope: "project"` — it is also what
 * "customise this template for this project" means: a full, independent fork
 * pinned to one workspace, so editing it can never disturb the shared library
 * or another repo that starts from the same shape.
 */
export function deriveTemplate(
  template: WorkflowTemplate,
  init: { scope?: Exclude<TemplateScope, "builtin">; name?: string } = {},
): WorkflowTemplate {
  const scope = init.scope ?? "project";
  return {
    id: uid("wft"),
    name: init.name ?? `${template.name}${scope === "project" ? " (this project)" : " (copy)"}`,
    scope,
    description: template.description,
    basedOn: template.id,
    stages: template.stages.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })),
  };
}

/** Back-compat alias: a same-scope copy. */
export function duplicateTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return deriveTemplate(template, {
    scope: templateScope(template) === "global" ? "global" : "project",
    name: `${template.name} (copy)`,
  });
}

/**
 * The standard template: manager → plan + design (parallel) → develop +
 * review (parallel tracks, pipelined per track) → merge → release. `refine`
 * is the manager's own interactive stage; `plan` and `design` share the same
 * dependency so they run concurrently; `develop` and `review` are per-track —
 * a track's review starts as soon as *its* development settles, while other
 * tracks are still developing (so review only depends on plan/design, not on
 * the whole develop stage).
 */
export const STANDARD_WORKFLOW_TEMPLATE: WorkflowTemplate = {
  id: "standard",
  name: "Standard delivery",
  scope: "builtin",
  description: "Plan and design in parallel, build on parallel tracks, merge, release.",
  stages: [
    {
      id: "refine",
      name: "Refine",
      purpose: "manage",
      dependsOn: [],
      perTrack: false,
      description: "Sharpen the goal into concrete, testable requirements with the user.",
      handoff: "A settled requirements list — testable statements, open questions answered.",
      boardStatus: null,
    },
    {
      id: "plan",
      name: "Plan",
      purpose: "plan",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Break the requirements into board tasks with acceptance criteria and ordering.",
      handoff: "Board tasks under the workflow's epic, each with acceptance criteria and blockedBy ordering.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "design",
      name: "Design",
      purpose: "design",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Design the architecture/API/UI surface the plan builds against (parallel with Plan).",
      handoff: "The interface the implementation codes against: module boundaries, API shapes, UI states.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "develop",
      name: "Develop",
      purpose: "implement",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Implement each parallel track on its own branch in an isolated worktree.",
      handoff: "Committed work on the track branch, its own tests passing.",
      boardStatus: "in_progress",
      model: "opus",
    },
    {
      id: "review",
      name: "Review",
      purpose: "code-review",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Review each track as its development settles; findings loop back as fixes.",
      handoff: "A verdict per track: approved, or findings dispatched back to develop as fix workers.",
      boardStatus: "review",
      model: "sonnet",
    },
    {
      id: "merge",
      name: "Merge",
      purpose: "merge",
      dependsOn: ["develop", "review"],
      perTrack: false,
      description: "Merge the reviewed track branches, resolve conflicts, and get tests green.",
      handoff: "One integrated main line with every track merged and the suite green.",
      boardStatus: "done",
      model: "opus",
    },
    {
      id: "release",
      name: "Release",
      purpose: "release",
      dependsOn: ["merge"],
      perTrack: false,
      description: "Release chores: changelog, version bump, tags, release notes.",
      handoff: "A tagged release with notes describing what shipped.",
      boardStatus: "done",
      model: "sonnet",
    },
  ],
};

/**
 * The simple template: one track, one strictly linear chain of handoffs.
 * Every stage has exactly one predecessor, so the artifact passed forward is
 * unambiguous — the shape to reach for on a bounded change (a bug, one
 * feature) where splitting into parallel tracks costs more coordination than
 * it saves.
 */
export const SIMPLE_WORKFLOW_TEMPLATE: WorkflowTemplate = {
  id: "simple",
  name: "Simple handoff",
  scope: "builtin",
  description: "One track, five stages, each handing one artifact to the next. Good for a bounded change.",
  stages: [
    {
      id: "refine",
      name: "Refine",
      purpose: "manage",
      dependsOn: [],
      perTrack: false,
      description: "Agree what done looks like before anything is dispatched.",
      handoff: "A one-paragraph statement of the change and the acceptance criteria it must meet.",
      boardStatus: null,
    },
    {
      id: "plan",
      name: "Plan",
      purpose: "plan",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Read the code the change touches and write the task list against it.",
      handoff: "Board tasks in order, each naming the files it touches and how it will be verified.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "build",
      name: "Build",
      purpose: "implement",
      dependsOn: ["plan"],
      perTrack: false,
      description: "Implement the tasks in order, committing as each lands.",
      handoff: "Committed work with tests, task by task, on the working branch.",
      boardStatus: "in_progress",
      model: "opus",
    },
    {
      id: "verify",
      name: "Verify",
      purpose: "code-review",
      dependsOn: ["build"],
      perTrack: false,
      description: "Review the diff against the acceptance criteria and run the suite.",
      handoff: "Either an approval, or fix tasks handed back to Build — nothing in between.",
      boardStatus: "review",
      model: "sonnet",
    },
    {
      id: "ship",
      name: "Ship",
      purpose: "merge",
      dependsOn: ["verify"],
      perTrack: false,
      description: "Merge to the main line and confirm it is green there.",
      handoff: "The change on the main line, suite green, tasks closed.",
      boardStatus: "done",
      model: "opus",
    },
  ],
};

/**
 * The advanced template: research feeds plan and design, work fans out across
 * parallel tracks, and three independent checks (per-track review, one
 * security pass over the whole change, a CI gate on the merged line) have to
 * agree before release. Reach for it when the change is large enough that the
 * unknowns are worth spiking and the risk is worth checking more than once.
 */
export const ADVANCED_WORKFLOW_TEMPLATE: WorkflowTemplate = {
  id: "advanced",
  name: "Advanced delivery",
  scope: "builtin",
  description:
    "Research, parallel tracks, tests authored beside the code, review + security + CI gates, then release.",
  stages: [
    {
      id: "refine",
      name: "Refine",
      purpose: "manage",
      dependsOn: [],
      perTrack: false,
      description: "Turn the goal into requirements and name the unknowns worth spiking.",
      handoff: "Requirements, plus the explicit list of questions Research has to answer.",
      boardStatus: null,
    },
    {
      id: "research",
      name: "Research",
      purpose: "survey",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Spike the unknowns: read the existing code, try the risky bit, cost the options.",
      handoff: "A findings note per unknown with a recommendation — this is what makes the plan cheap.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "plan",
      name: "Plan",
      purpose: "plan",
      dependsOn: ["research"],
      perTrack: false,
      description: "Split the work into independent slices that can run as parallel tracks.",
      handoff: "Board tasks grouped into candidate tracks, each slice independently mergeable.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "design",
      name: "Design",
      purpose: "design",
      dependsOn: ["research"],
      perTrack: false,
      description: "Fix the contracts between the slices so tracks cannot drift apart (parallel with Plan).",
      handoff: "The shared contracts — types, API shapes, schema changes — every track codes against.",
      boardStatus: "backlog",
      model: "sonnet",
    },
    {
      id: "develop",
      name: "Develop",
      purpose: "implement",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Implement each track on its own branch in an isolated worktree.",
      handoff: "Committed work on the track branch, honouring the shared contracts.",
      boardStatus: "in_progress",
      model: "opus",
    },
    {
      id: "test",
      name: "Test",
      purpose: "implement",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Author tests from the acceptance criteria, on the same branch as the track's code.",
      handoff: "Executable acceptance criteria — the tests Review reads the diff against.",
      boardStatus: "in_progress",
      model: "sonnet",
    },
    {
      id: "review",
      name: "Review",
      purpose: "code-review",
      dependsOn: ["develop", "test"],
      perTrack: true,
      description: "Review each track as its development settles; findings loop back as fixes.",
      handoff: "A per-track verdict; findings go back to Develop as fix workers on the same branch.",
      boardStatus: "review",
      model: "sonnet",
    },
    {
      id: "security",
      name: "Security",
      purpose: "security-review",
      dependsOn: ["develop"],
      perTrack: false,
      description: "One pass over the whole change: authz, input handling, secrets, dependencies.",
      handoff: "A security verdict over the combined change, with anything blocking raised as a task.",
      boardStatus: "review",
      model: "sonnet",
    },
    {
      id: "merge",
      name: "Merge",
      purpose: "merge",
      dependsOn: ["review", "security"],
      perTrack: false,
      description: "Merge the approved track branches and resolve conflicts between them.",
      handoff: "One integrated main line carrying every approved track.",
      boardStatus: "done",
      model: "opus",
    },
    {
      id: "gate",
      name: "CI gate",
      purpose: "ci",
      dependsOn: ["merge"],
      perTrack: false,
      description: "Full suite, typecheck and build on the merged line — the last check before release.",
      handoff: "A green merged line, or fix tasks with the failing output attached.",
      boardStatus: "done",
      model: "sonnet",
    },
    {
      id: "release",
      name: "Release",
      purpose: "release",
      dependsOn: ["gate"],
      perTrack: false,
      description: "Release chores: changelog, version bump, tags, release notes.",
      handoff: "A tagged release with notes describing what shipped.",
      boardStatus: "done",
      model: "sonnet",
    },
  ],
};

/** Known templates by id. */
export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  [SIMPLE_WORKFLOW_TEMPLATE.id]: SIMPLE_WORKFLOW_TEMPLATE,
  [STANDARD_WORKFLOW_TEMPLATE.id]: STANDARD_WORKFLOW_TEMPLATE,
  [ADVANCED_WORKFLOW_TEMPLATE.id]: ADVANCED_WORKFLOW_TEMPLATE,
};

export function workflowTemplate(templateId: string): WorkflowTemplate {
  return WORKFLOW_TEMPLATES[templateId] ?? STANDARD_WORKFLOW_TEMPLATE;
}

/**
 * The template a workflow runs on: its embedded snapshot when it has one
 * (custom templates are snapshotted at start), else the built-in registry.
 * Every consumer of a workflow's stage graph goes through here — never
 * straight to {@link workflowTemplate} — or custom-template workflows would
 * silently fall back to the standard stages.
 */
export function templateOf(workflow: Pick<Workflow, "templateId" | "template">): WorkflowTemplate {
  return workflow.template ?? workflowTemplate(workflow.templateId);
}

/* ------------------------------------------------------------------ */
/* Stage graph ↔ board                                                 */
/* ------------------------------------------------------------------ */

/**
 * Non-blocking advice about a template — things that make a workflow behave
 * worse without making it invalid. Kept apart from
 * {@link validateWorkflowTemplate} deliberately: these must never stop a save,
 * because half-finished is a normal state in a visual builder.
 */
export function templateWarnings(template: WorkflowTemplate): string[] {
  const warnings: string[] = [];
  const ids = new Set(template.stages.map((s) => s.id));
  const hasDependents = new Set(template.stages.flatMap((s) => s.dependsOn));

  for (const stage of template.stages) {
    // A stage nothing consumes needs no handoff; one that feeds another and
    // says nothing leaves the next worker to guess what it was given.
    if (hasDependents.has(stage.id) && !stage.handoff.trim()) {
      warnings.push(`${stage.name || stage.id} feeds another stage but declares no handoff.`);
    }
    if (!stage.description.trim()) {
      warnings.push(`${stage.name || stage.id} has no description — the manager's brief will be thin.`);
    }
  }
  // More than one root is fine (parallel entry points); none is not — with a
  // valid DAG that cannot happen, but a cycle reported by validate can look
  // like it here, so only mention it when the graph is otherwise sound.
  const roots = template.stages.filter((s) => !s.dependsOn.some((d) => ids.has(d)));
  if (template.stages.length > 1 && roots.length > 1) {
    warnings.push(
      `${roots.length} stages start immediately (${roots.map((s) => s.id).join(", ")}) — intended?`,
    );
  }
  if (!template.stages.some((s) => s.boardStatus === "done")) {
    warnings.push("No stage lands work in the board's done column.");
  }
  return warnings;
}

/** The board column a stage's tasks occupy while it works, or null. */
export function stageBoardStatus(
  template: WorkflowTemplate,
  stageId: string,
): TaskStatus | null {
  return template.stages.find((s) => s.id === stageId)?.boardStatus ?? null;
}

/**
 * The stages feeding each board column — the mapping read from the board's
 * side. A column with no stages is normal (nothing in this template parks
 * work there); a column with several is normal too (develop and test both
 * sit in progress).
 */
export function boardColumnStages(
  template: WorkflowTemplate,
): Record<TaskStatus, WorkflowStageDef[]> {
  const columns = { backlog: [], in_progress: [], review: [], done: [] } as Record<
    TaskStatus,
    WorkflowStageDef[]
  >;
  for (const stage of template.stages) {
    if (stage.boardStatus) columns[stage.boardStatus].push(stage);
  }
  return columns;
}

/**
 * Board columns whose stage is active right now — what the board should be
 * showing movement in. Derived from live stage state, so it is empty for a
 * workflow that has not started dispatching.
 */
export function activeBoardStatuses(workflow: Workflow): Set<TaskStatus> {
  const template = templateOf(workflow);
  const active = new Set<TaskStatus>();
  for (const state of workflow.stages) {
    if (state.status !== "active") continue;
    const status = stageBoardStatus(template, state.id);
    if (status) active.add(status);
  }
  return active;
}

/**
 * The stage ↔ column contract as the manager reads it. Rendered into the
 * kickoff prompt so moving a task is a lookup rather than a judgement call —
 * the board is the thing humans watch, and a manager that keeps its own
 * private notion of progress makes it lie.
 */
export function boardMappingText(template: WorkflowTemplate): string {
  const columns = boardColumnStages(template);
  const lines: string[] = [];
  for (const status of TASK_STATUSES) {
    const stages = columns[status];
    if (stages.length) {
      lines.push(`- ${status}: ${stages.map((s) => s.id).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

export const WORKFLOW_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const WorkflowStatusSchema = z.enum(WORKFLOW_STATUSES);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WORKFLOW_STAGE_STATUSES = ["pending", "active", "done", "skipped"] as const;
export const WorkflowStageStatusSchema = z.enum(WORKFLOW_STAGE_STATUSES);
export type WorkflowStageStatus = z.infer<typeof WorkflowStageStatusSchema>;

export const WorkflowStageStateSchema = z.object({
  /** Stage id from the template. */
  id: z.string(),
  status: WorkflowStageStatusSchema.default("pending"),
  startedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
  /** Manager's note on the stage outcome (what the plan said, review verdict…). */
  note: z.string().nullish(),
});
export type WorkflowStageState = z.infer<typeof WorkflowStageStateSchema>;

export const WORKFLOW_TRACK_STATUSES = ["active", "merged", "abandoned"] as const;
export const WorkflowTrackStatusSchema = z.enum(WORKFLOW_TRACK_STATUSES);
export type WorkflowTrackStatus = z.infer<typeof WorkflowTrackStatusSchema>;

/** One parallel development track: a branch plus the board tasks riding it. */
export const WorkflowTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Git branch the track's develop workers commit to (worktree-isolated). */
  branch: z.string(),
  /** Board task ids assigned to this track. */
  taskIds: z.array(z.string()).default([]),
  status: WorkflowTrackStatusSchema.default("active"),
  createdAt: z.string(),
});
export type WorkflowTrack = z.infer<typeof WorkflowTrackSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The user's goal, refined over the manager's `refine` stage. */
  goal: z.string(),
  templateId: z.string().default(STANDARD_WORKFLOW_TEMPLATE.id),
  /**
   * Snapshot of a custom template's stage graph, taken at start. Built-in
   * templates resolve by id; customs embed so later edits/deletes in the
   * builder can't change a workflow that is already running.
   */
  template: WorkflowTemplateSchema.nullish(),
  /** Board the workflow plans onto (null = the workspace's first board). */
  projectId: z.string().nullish(),
  /** Epic the manager created for this workflow, once it exists. */
  epicId: z.string().nullish(),
  /** Working directory relative to the workspace root. */
  cwd: z.string().default("."),
  /** Agent profile the manager was dispatched to (model/skills resolution). */
  agentId: z.string().nullish(),
  /** Root run of the manager's resume chain (the interactive session). */
  managerRunId: z.string().nullish(),
  status: WorkflowStatusSchema.default("running"),
  /**
   * What paused the workflow — structured so budget pauses are
   * distinguishable from user holds without parsing the display reason
   * (raising the budget auto-resumes only budget pauses; `stall` is the
   * engine catching consecutive manager turns that settled nothing).
   */
  pausedBy: z.enum(["user", "budget", "stall"]).nullish(),
  /** Human-readable pause reason (display only — see pausedBy). */
  pausedReason: z.string().nullish(),
  /**
   * Pre-flight environment report taken at start (null = not probed, e.g.
   * headless embeddings). Gaps are rendered into the manager's prompt and
   * status text — the difference between "pnpm is missing" being a $0 fact
   * in the kickoff and a $2 discovery by a failed worker.
   */
  env: EnvReportSchema.nullish(),
  /**
   * Premise-check report taken at start (null = the goal/brief carried no
   * `assert:` lines, or the repo could not be probed). A brief's checkable
   * claims are verified against the real repo before the first paid run —
   * failures are rendered into the kickoff prompt, the status text, and the
   * hub's dispatch report, so a false premise is corrected before work is
   * built on it.
   */
  premise: PremiseReportSchema.nullish(),
  /**
   * Progress fingerprint as of the last settled manager turn (see
   * {@link workflowProgressFingerprint}) plus how many consecutive manager
   * turns ended without changing it. The typed-outcome contract: every
   * manager turn must settle something (stage/board/track movement, a
   * dispatch, a question, completion) — turns that don't are stalls, and
   * {@link STALL_TURN_LIMIT} of them in a row pauses the workflow instead of
   * letting resumes burn budget against an unchanged board.
   */
  progressFingerprint: z.string().nullish(),
  noProgressTurns: z.number().default(0),
  /**
   * Marginal value per manager turn: what each settled turn cost and whether
   * it changed the progress fingerprint. The spend list already shows money
   * leaving; this is the other axis — a turn that cost $1.80 and settled
   * nothing should be visually loud, not derivable only by diffing board
   * revisions by hand. Bounded (see {@link TURN_LOG_LIMIT}).
   */
  turnLog: z.array(
    z.object({
      runId: z.string(),
      at: z.string(),
      costUsd: z.number(),
      progressed: z.boolean(),
    }),
  ).default([]),
  /** Manager's completion summary (set via complete_workflow). */
  summary: z.string().nullish(),
  /** Spend ceiling in USD; dispatches are refused once spend crosses it. */
  budgetUsd: z.number().nullish(),
  /**
   * Per-run spend ceiling in USD. Stamped onto every run of the workflow
   * (manager turns and dispatched workers); the AgentManager kills a run
   * live once its streamed usage crosses the cap. The lever against the
   * single runaway run — a $2.25 manager turn that could not possibly have
   * helped — where `budgetUsd` only catches the accumulated total.
   */
  runCapUsd: z.number().nullish(),
  /**
   * When the pre-exhaustion budget warning was delivered (see
   * {@link BUDGET_WARN_FRACTION}) — the tripwire fires once, not on every
   * settlement past the threshold. Cleared when the budget is raised.
   */
  budgetWarnedAt: z.string().nullish(),
  stages: z.array(WorkflowStageStateSchema),
  tracks: z.array(WorkflowTrackSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export function createWorkflow(init: {
  name: string;
  goal: string;
  templateId?: string;
  /** Custom template to run on — validated and snapshotted into the record. */
  template?: WorkflowTemplate | null;
  projectId?: string | null;
  cwd?: string;
  agentId?: string | null;
  budgetUsd?: number | null;
  runCapUsd?: number | null;
}): Workflow {
  const template =
    init.template ?? workflowTemplate(init.templateId ?? STANDARD_WORKFLOW_TEMPLATE.id);
  if (init.template) {
    const errors = validateWorkflowTemplate(init.template);
    if (errors.length) throw new Error(`Invalid workflow template: ${errors.join(" ")}`);
  }
  const ts = nowIso();
  return WorkflowSchema.parse({
    id: uid("wf"),
    name: init.name,
    goal: init.goal,
    templateId: template.id,
    template: init.template ?? null,
    projectId: init.projectId ?? null,
    cwd: init.cwd ?? ".",
    agentId: init.agentId ?? null,
    budgetUsd: init.budgetUsd ?? null,
    runCapUsd: init.runCapUsd ?? null,
    stages: template.stages.map((s) => ({ id: s.id, status: "pending" as const })),
    createdAt: ts,
    updatedAt: ts,
  });
}

/** Dimensional tag carried by every run belonging to a workflow. */
export function workflowTag(workflowId: string): string {
  return `workflow:${workflowId}`;
}

/** True for tags minted by {@link workflowTag} — the single prefix check. */
export function isWorkflowTag(tag: string): boolean {
  return tag.startsWith("workflow:");
}

/** The workflow id a run belongs to (from its tags), or null. */
export function workflowIdOfRun(run: Pick<AgentRun, "tags">): string | null {
  // Tolerate records predating the tags field — spend must degrade to
  // "unattributed", never crash the manager's workflow_status.
  for (const tag of run.tags ?? []) {
    if (isWorkflowTag(tag)) return tag.slice("workflow:".length) || null;
  }
  return null;
}

/** Every run attributed to the workflow (manager chain + workers), any status. */
export function runsForWorkflow(workflowId: string, runs: readonly AgentRun[]): AgentRun[] {
  const tag = workflowTag(workflowId);
  return runs.filter((r) => (r.tags ?? []).includes(tag));
}

/* ------------------------------------------------------------------ */
/* Stage transitions                                                   */
/* ------------------------------------------------------------------ */

export type StageTransition =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: string };

/**
 * Move one stage to a new status. Activating (or completing) a stage requires
 * every dependency to be done or skipped — the graph is the rail the manager
 * runs on; `skipped` marks stages the goal doesn't need (e.g. no release).
 * Returns a new workflow; the input is never mutated.
 */
export function setStageStatus(
  workflow: Workflow,
  stageId: string,
  status: WorkflowStageStatus,
  note?: string | null,
  at = nowIso(),
): StageTransition {
  const template = templateOf(workflow);
  const def = template.stages.find((s) => s.id === stageId);
  if (!def) return { ok: false, reason: `Unknown stage: ${stageId}` };
  const state = workflow.stages.find((s) => s.id === stageId);
  if (!state) return { ok: false, reason: `Stage ${stageId} missing from workflow state` };

  if (status === "active" || status === "done") {
    const byId = new Map(workflow.stages.map((s) => [s.id, s]));
    const unmet = def.dependsOn.filter((dep) => {
      const depStatus = byId.get(dep)?.status;
      return depStatus !== "done" && depStatus !== "skipped";
    });
    if (unmet.length) {
      return {
        ok: false,
        reason: `Stage ${stageId} requires ${unmet.join(", ")} to be done first.`,
      };
    }
  }

  const stages = workflow.stages.map((s) =>
    s.id === stageId
      ? {
          ...s,
          status,
          note: note ?? s.note ?? null,
          startedAt: s.startedAt ?? (status === "active" || status === "done" ? at : null),
          endedAt: status === "done" || status === "skipped" ? at : null,
        }
      : s,
  );
  return { ok: true, workflow: { ...workflow, stages, updatedAt: at } };
}

/** Move one track to a new status. Returns a new workflow; never mutates. */
export function setTrackStatus(
  workflow: Workflow,
  trackId: string,
  status: WorkflowTrackStatus,
  at = nowIso(),
):
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: string } {
  if (!workflow.tracks.some((t) => t.id === trackId)) {
    return { ok: false, reason: `Unknown track: ${trackId}` };
  }
  return {
    ok: true,
    workflow: {
      ...workflow,
      tracks: workflow.tracks.map((t) => (t.id === trackId ? { ...t, status } : t)),
      updatedAt: at,
    },
  };
}

/** Default branch name for a track: `wf/<workflow-slug>/<track-slug>`. */
export function defaultTrackBranch(workflow: Workflow, trackName: string): string {
  return `wf/${slugify(workflow.name)}/${slugify(trackName)}`;
}

/** Add a parallel development track (branch defaults to {@link defaultTrackBranch}). */
export function addTrack(
  workflow: Workflow,
  init: { name: string; branch?: string | null; taskIds?: string[] },
  at = nowIso(),
): { workflow: Workflow; track: WorkflowTrack } {
  const track = WorkflowTrackSchema.parse({
    id: uid("track"),
    name: init.name,
    branch: init.branch?.trim() || defaultTrackBranch(workflow, init.name),
    taskIds: init.taskIds ?? [],
    createdAt: at,
  });
  return {
    workflow: { ...workflow, tracks: [...workflow.tracks, track], updatedAt: at },
    track,
  };
}

/* ------------------------------------------------------------------ */
/* Cost accounting                                                     */
/* ------------------------------------------------------------------ */

export interface WorkflowSpend {
  /** Every token, cache reads included, across all attributed runs. */
  totalTokens: number;
  costUsd: number;
  runCount: number;
  /** Runs still queued/running (their usage is included live). */
  liveRunCount: number;
}

/**
 * The workflow's spend across every attributed run, live runs included. The
 * CLI-reported `costUsd` wins per run; usage-based estimation covers runs
 * that are still streaming (same convention as task cost attribution).
 */
export function workflowSpend(workflowId: string, runs: readonly AgentRun[]): WorkflowSpend {
  const mine = runsForWorkflow(workflowId, runs);
  let totalTokens = 0;
  let costUsd = 0;
  let liveRunCount = 0;
  for (const run of mine) {
    totalTokens += usageTotalTokens(run.usage);
    costUsd += runCostUsd(run);
    if (run.status === "running" || run.status === "queued") liveRunCount += 1;
  }
  return { totalTokens, costUsd, runCount: mine.length, liveRunCount };
}

export interface BudgetState {
  budgetUsd: number | null;
  spentUsd: number;
  /** Null when no budget is set (unlimited). */
  remainingUsd: number | null;
  exhausted: boolean;
}

export function budgetState(workflow: Workflow, spend: WorkflowSpend): BudgetState {
  const budget = workflow.budgetUsd ?? null;
  const remaining = budget != null ? budget - spend.costUsd : null;
  return {
    budgetUsd: budget,
    spentUsd: spend.costUsd,
    remainingUsd: remaining,
    exhausted: remaining != null && remaining <= 0,
  };
}

/**
 * Fraction of the budget at which the manager gets a one-shot warning —
 * exhaustion already pauses the workflow, but by then the wrap-up itself has
 * nothing left to spend. The tripwire fires while there is still money to
 * land the plane (or to ask the owner for more runway).
 */
export const BUDGET_WARN_FRACTION = 0.8;

/** True once spend has crossed the warning threshold of a set budget. */
export function budgetWarningDue(budget: BudgetState): boolean {
  return budget.budgetUsd != null && budget.spentUsd >= budget.budgetUsd * BUDGET_WARN_FRACTION;
}

/** The one-shot pre-exhaustion notice delivered into the manager session. */
export function budgetWarningText(budget: BudgetState): string {
  const pct = budget.budgetUsd ? Math.round((budget.spentUsd / budget.budgetUsd) * 100) : 0;
  return (
    `BUDGET WARNING: $${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd?.toFixed(2)} spent (${pct}%). ` +
    `Once the budget is exhausted, dispatches are refused and the workflow pauses. Plan the remainder now: ` +
    `finish what can land within it, and if the goal cannot, raise ask_question immediately with a ` +
    `recommendation — raise the budget, cut scope, or stop here.`
  );
}

/* ------------------------------------------------------------------ */
/* Typed turn outcomes (stall detection)                               */
/* ------------------------------------------------------------------ */

/** Consecutive no-progress manager turns before the workflow auto-pauses. */
export const STALL_TURN_LIMIT = 2;

/** One settled manager turn in the marginal-value log. */
export type WorkflowTurn = Workflow["turnLog"][number];

/** Manager turns the marginal-value log keeps (oldest fall off). */
export const TURN_LOG_LIMIT = 50;

/** Append a settled manager turn to the bounded log (newest last). */
export function appendTurnLog(log: readonly WorkflowTurn[], turn: WorkflowTurn): WorkflowTurn[] {
  const next = [...log, turn];
  return next.length > TURN_LOG_LIMIT ? next.slice(next.length - TURN_LOG_LIMIT) : next;
}

/**
 * Everything a manager turn can legitimately change, folded into one
 * comparable string: workflow structure (stages, tracks, status, epic,
 * summary), the number of workers ever dispatched, and the workflow's board
 * tasks (statuses and open questions). Two equal fingerprints across a
 * settled manager turn mean the turn ended *untyped* — it neither settled
 * work, asked, nor failed — which is the failure mode where six resumes cost
 * $9 against a board at rev 0. Deliberately excludes timestamps and spend:
 * money leaving is not progress.
 */
export function workflowProgressFingerprint(
  workflow: Workflow,
  /** Runs ever dispatched for this workflow, manager chain excluded. */
  workerRunCount: number,
  /** The project board(s) — filtered to the workflow's own tasks here. */
  tasks: readonly TaskItem[] = [],
): string {
  const mine = workflowTasks(workflow, tasks);
  return JSON.stringify({
    status: workflow.status,
    epicId: workflow.epicId ?? null,
    summary: workflow.summary ?? null,
    stages: workflow.stages.map((s) => `${s.id}:${s.status}:${s.note ?? ""}`),
    tracks: workflow.tracks.map((t) => `${t.id}:${t.status}`).sort(),
    workers: workerRunCount,
    tasks: mine.map((t) => `${t.id}:${t.status}`).sort(),
    openQuestions: mine
      .flatMap((t) => t.questions.filter((q) => q.answer == null).map((q) => q.id))
      .sort(),
  });
}

/* ------------------------------------------------------------------ */
/* Agent-facing rendering                                              */
/* ------------------------------------------------------------------ */

/** The workflow_status tool text: stages, tracks, spend vs budget. */
export function workflowStatusText(workflow: Workflow, spend: WorkflowSpend): string {
  const template = templateOf(workflow);
  const lines = [
    `Workflow ${workflow.id}: ${workflow.name} [${workflow.status}]` +
      (workflow.pausedReason ? ` — ${workflow.pausedReason}` : ""),
    `Goal: ${workflow.goal}`,
  ];
  if (workflow.epicId) lines.push(`Epic: ${workflow.epicId}`);
  lines.push("", "Stages:");
  for (const def of template.stages) {
    const state = workflow.stages.find((s) => s.id === def.id);
    const bits = [
      `- ${def.id} [${state?.status ?? "pending"}]`,
      def.perTrack ? "(per track)" : null,
      def.boardStatus ? `board: ${def.boardStatus}` : null,
      state?.note ? `— ${state.note}` : null,
    ].filter(Boolean);
    lines.push(bits.join(" "));
    // The handoff of a *done* stage is what the stages now unblocked are
    // owed, so it stays in the status text rather than only in the kickoff
    // prompt — by the time it matters the prompt is many turns back.
    if (def.handoff && state?.status !== "pending") {
      lines.push(`    hands off: ${def.handoff}`);
    }
  }
  if (workflow.tracks.length) {
    lines.push("", "Tracks:");
    for (const t of workflow.tracks) {
      lines.push(
        `- ${t.id} "${t.name}" [${t.status}] branch: ${t.branch}` +
          (t.taskIds.length ? ` tasks: ${t.taskIds.join(", ")}` : ""),
      );
    }
  }
  const budget = budgetState(workflow, spend);
  lines.push(
    "",
    `Spend: $${spend.costUsd.toFixed(2)} across ${spend.runCount} runs (${Math.round(spend.totalTokens / 1000)}k tok, ${spend.liveRunCount} live)` +
      (budget.budgetUsd != null
        ? ` — budget $${budget.budgetUsd.toFixed(2)}, remaining $${Math.max(0, budget.remainingUsd ?? 0).toFixed(2)}${budget.exhausted ? " (EXHAUSTED)" : ""}`
        : " — no budget set") +
      (workflow.runCapUsd != null ? ` — per-run cap $${workflow.runCapUsd.toFixed(2)}` : ""),
  );
  // The pre-flight gap stays in the status text, not just the kickoff — by
  // the time a stage needs the missing tool, the kickoff is many turns back.
  if (workflow.env && !workflow.env.ok) {
    lines.push(
      `Environment gaps: ${envGaps(workflow.env)
        .map((c) => `${c.label} missing (${c.reason})`)
        .join(", ")}`,
    );
  }
  // Same persistence rule for failed premises — the brief's false claims
  // stay visible for as long as the workflow runs against them.
  if (workflow.premise && !workflow.premise.ok) {
    lines.push(
      `Failed premises: ${premiseGaps(workflow.premise)
        .map((c) => `${c.raw} (${c.detail ?? "does not hold"})`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The manager's kickoff prompt: the standing directive that makes one
 * interactive Claude session drive the whole workflow — refine → dispatch →
 * review → merge → release — through its MCP tools, under budget control,
 * steerable by user messages at any time.
 */
export function buildWorkflowManagerPrompt(
  workflow: Workflow,
  /** The dispatchable agent roster; rendered so assignment is a lookup by id. */
  roster: readonly AgentProfile[] = [],
  /** The project's model preset — resolves "auto" profile models in the rendering. */
  preset?: ModelPreset,
): string {
  const template = templateOf(workflow);
  const budget =
    (workflow.budgetUsd != null
      ? `Your budget is $${workflow.budgetUsd.toFixed(2)}. Check workflow_status before each wave of dispatches; once spend crosses the budget, dispatches are refused and the workflow pauses — warn the user via ask_question *before* that happens if the goal looks bigger than the budget.`
      : "No budget is set, but you still account for cost: check workflow_status between waves and prefer small, well-scoped workers.") +
    (workflow.runCapUsd != null
      ? ` Every run (your own turns included) is hard-capped at $${workflow.runCapUsd.toFixed(2)} — a run crossing the cap is killed mid-flight, so scope each worker to fit under it.`
      : "");
  const byId = new Map(template.stages.map((s) => [s.id, s]));
  const stageList = template.stages
    .map((s, i) => {
      const attrs = [
        s.id,
        s.perTrack ? "per track" : null,
        s.agentId ? `agent: ${s.agentId}` : null,
        s.model ? `model: ${s.model}` : null,
        s.boardStatus ? `board: ${s.boardStatus}` : null,
      ].filter(Boolean);
      const lines = [`${i + 1}. ${s.name} (${attrs.join(", ")}) — ${s.description}`];
      if (s.handoff) lines.push(`   Hands off: ${s.handoff}`);
      // What this stage is owed, named at the point the manager briefs its
      // worker. Dependencies say when a stage may start; only the upstream
      // handoffs say what its worker should already have in hand.
      const inputs = s.dependsOn
        .map((dep) => byId.get(dep))
        .filter((dep): dep is WorkflowStageDef => dep != null && dep.handoff.trim().length > 0)
        .map((dep) => `${dep.id} → ${dep.handoff}`);
      if (inputs.length) lines.push(`   Receives: ${inputs.join(" | ")}`);
      return lines.join("\n");
    })
    .join("\n");
  const boardMapping = boardMappingText(template);
  const agents = rosterText(roster, preset);
  const envNote = envGapPromptNote(workflow.env);
  const premiseNote = premiseGapPromptNote(workflow.premise);
  return [
    `You are the MANAGER of workflow "${workflow.name}" (${workflow.id}) — a long-lived, interactive coordination session. You coordinate and control; you do not implement anything yourself.`,
    "",
    `Goal:\n${workflow.goal.trim()}`,
    ...(envNote ? ["", envNote] : []),
    ...(premiseNote ? ["", premiseNote] : []),
    "",
    `Stages (template "${template.name}"; advance them with advance_stage as work moves — done stages unlock their dependents):`,
    stageList,
    ...(agents
      ? [
          "",
          "Agent roster (dispatch by passing dispatch_worker's `agentId` — the server applies that profile's model, skills and standing instructions):",
          agents,
        ]
      : []),
    "",
    "Operating protocol:",
    ...stageProtocolLines(template),
    "",
    "Rules:",
    "- Every dispatch is a HANDOFF. Brief each worker with what its stage receives (the upstream handoffs above) and hold it to producing that stage's own handoff — a worker that returns something the next stage cannot consume has not finished, and the fix is another turn on the same stage, not advancing past it.",
    boardMapping
      ? `- The board is the single source of truth, and this template maps stages onto it:\n${boardMapping}\n  Move a stage's tasks into its column as you dispatch (update_task), and keep them honest: nothing sits in a column whose stage is not the one doing the work. Stages with no column listed are coordination only — they move nothing.`
      : "- The board is the single source of truth. Coordinate through it: board_status, get_task, claim_task → update_task → release_task, and keep task statuses honest.",
    "- Coordinate through the board's tools: board_status, get_task, claim_task → update_task → release_task.",
    `- Cost accounting is your job. ${budget}`,
    "- Agent routing: a stage naming an agent is dispatched with that `agentId`; otherwise pick from the roster by tags/skills, or fall back to the stage's suggested `model` — heavyweight models only where code gets written; lighter models for planning, review and release chores.",
    "- You are resumed automatically whenever dispatched workers settle — end your turn after dispatching instead of polling worker_status in a loop.",
    `- Every turn must end TYPED: dispatch a worker, advance/skip a stage, move board tasks, raise ask_question, or complete_workflow. Deliberating without settling anything is a stall — after ${STALL_TURN_LIMIT} consecutive turns that change nothing, the workflow auto-pauses and stops taking dispatches. If you are blocked, SAY SO with ask_question (it is free and it is the only reliable unblock path); never end a turn having silently changed nothing.`,
    "- Record decisions as you go: advance_stage notes, task descriptions, and answers to user questions are the durable memory of this workflow.",
    "- A stage the goal does not need is skipped explicitly (advance_stage status \"skipped\"), never left pending — its dependents cannot start until it settles either way.",
    "- When the goal is met — or genuinely blocked — call complete_workflow with a short summary of what shipped, what it cost, and anything left open.",
  ].join("\n");
}

/**
 * The per-stage protocol, generated from the stages a template actually has.
 *
 * This used to be a fixed script naming the standard template's stage ids,
 * which silently misdirected any other graph — a manager told to "mark refine
 * done" on a template with no `refine` stage. Purposes are the stable
 * vocabulary (the template's ids are not), so each line is keyed on a purpose
 * and names the real ids it applies to.
 */
function stageProtocolLines(template: WorkflowTemplate): string[] {
  const ids = (predicate: (s: WorkflowStageDef) => boolean): string[] =>
    template.stages.filter(predicate).map((s) => s.id);
  const list = (of: string[]): string => of.join(", ");
  const lines: string[] = [];

  const manage = ids((s) => s.purpose === "manage");
  if (manage.length) {
    lines.push(
      `- ${list(manage)} is yours to run directly — no worker. Restate the goal as concrete, testable requirements, and use ask_question for decisions only the user can make (always with your recommended default). Advance it when the requirements are settled enough to plan against.`,
    );
  }
  const survey = ids((s) => s.purpose === "survey" || s.purpose === "index");
  if (survey.length) {
    lines.push(
      `- ${list(survey)}: dispatch a worker per open unknown, not one worker for all of them. Each returns findings and a recommendation; you fold them into the plan.`,
    );
  }
  const planning = ids((s) => s.purpose === "plan" || s.purpose === "design");
  if (planning.length) {
    lines.push(
      `- ${list(planning)}: dispatch a worker each (they share a dependency, so they run concurrently). Fold the results into the board — create_epic for the workflow, then create_task per unit of work with testable acceptance criteria and blockedBy ordering.`,
    );
  }

  const perTrack = ids((s) => s.perTrack);
  const build = ids((s) => s.purpose === "implement" || s.purpose === "fix");
  if (build.length) {
    lines.push(
      perTrack.length
        ? `- ${list(build)}: split independent slices of the plan into tracks with add_track (each gets its own git branch). Dispatch with isolation "worktree" and the track's branch so tracks never collide, and set taskId on every dispatch so cost bills the right task. Tell every worker to COMMIT on the track branch — worktrees are disposable, uncommitted work cannot be merged.`
        : `- ${list(build)}: dispatch workers task by task in the plan's order, each with its taskId set, and tell every one to COMMIT its work — uncommitted work cannot be reviewed or merged.`,
    );
  }
  const review = ids((s) => s.purpose === "code-review" || s.purpose === "security-review");
  if (review.length) {
    lines.push(
      `- ${list(review)}: dispatch as soon as the work it checks settles${perTrack.length ? " — per track, while other tracks are still building" : ""}. Findings go back as fix workers on the same branch; the stage advances only once its verdict is clean.`,
    );
  }
  const merge = ids((s) => s.purpose === "merge");
  if (merge.length) {
    lines.push(
      perTrack.length
        ? `- ${list(merge)}: once the checks are clean, merge each reviewed track with the merge_track tool — a deterministic --no-ff merge that marks the track merged, and on conflict aborts and returns the conflicted files. Dispatch a resolution worker only for those genuine conflicts, then get the suite green.`
        : `- ${list(merge)}: dispatch once the checks are clean, to merge into the main line, resolve conflicts and get the suite green.`,
    );
  }
  const ci = ids((s) => s.purpose === "ci");
  if (ci.length) {
    lines.push(
      `- ${list(ci)}: run the full suite, typecheck and build on the merged line. A failure here becomes fix tasks with the output attached — it does not advance.`,
    );
  }
  const release = ids((s) => s.purpose === "release");
  if (release.length) {
    lines.push(
      `- ${list(release)}: dispatch for changelog/version/tag chores, or skip the stage if the goal doesn't call for a release.`,
    );
  }
  lines.push(
    "- The user can message you at any time — those turns start with \"USER MESSAGE\". Treat them as steering from the owner: acknowledge, adjust course, keep driving.",
  );
  return lines;
}

/** Frame a user's interactive message for delivery into the manager session. */
export function formatUserMessage(text: string): string {
  return `USER MESSAGE:\n${text.trim()}\n\nThis is steering from the workflow's owner. Acknowledge it, adjust the plan/dispatches accordingly, and keep driving the workflow.`;
}

/**
 * The typed receipt a steering message gets back — the difference between a
 * paid dice-roll and knowing what happened. `interactive`: typed into the
 * manager's live terminal (free — the TUI queues its own input).
 * `resumed`: delivered by waking the session, which is a full-context resume
 * and costs accordingly. `queued`: parked for the next natural wake (a worker
 * settlement flushes the queue into that turn for free). `wakeExpected`
 * qualifies `queued`: whether any run of the workflow is live — i.e. whether
 * a natural wake is actually coming, or the message will sit until someone
 * forces one.
 */
export interface SteerReceipt {
  mode: "interactive" | "resumed" | "queued";
  wakeExpected: boolean;
}

/** Purpose for a stage's workers (template lookup with implement fallback). */
export function stagePurpose(workflow: Workflow, stageId: string): RunPurpose {
  const def = templateOf(workflow).stages.find((s) => s.id === stageId);
  return def ? def.purpose : RunPurposeSchema.parse("implement");
}

/* ------------------------------------------------------------------ */
/* Board attribution                                                   */
/* ------------------------------------------------------------------ */

/**
 * The board tasks belonging to a workflow: everything under its epic, plus
 * anything explicitly assigned to one of its tracks. One definition, because
 * two callers derive real behaviour from it — the workflow view lists a
 * workflow's open questions, and the hub wakes a program manager for them.
 */
export function workflowTasks(
  workflow: Pick<Workflow, "epicId" | "tracks">,
  tasks: readonly TaskItem[],
): TaskItem[] {
  const trackTaskIds = new Set(workflow.tracks.flatMap((t) => t.taskIds));
  return tasks.filter(
    (t) => (workflow.epicId != null && t.epicId === workflow.epicId) || trackTaskIds.has(t.id),
  );
}

/**
 * Every unanswered question on a workflow's tasks, paired with the task it
 * hangs off — a worker (or the manager) stopped and is waiting on a human.
 */
export function openQuestionsOfWorkflow(
  workflow: Pick<Workflow, "epicId" | "tracks">,
  tasks: readonly TaskItem[],
): { task: TaskItem; question: TaskQuestion }[] {
  return workflowTasks(workflow, tasks).flatMap((task) =>
    task.questions.filter((q) => q.answer == null).map((question) => ({ task, question })),
  );
}
