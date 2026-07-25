import { z } from "zod";
import { nowIso, slugify, uid } from "./ids.js";
import {
  usageTotalTokens,
  RunPurposeSchema,
  type AgentRun,
  type RunPurpose,
} from "./agent.js";
import { runCostUsd } from "./orchestration.js";
import type { TaskItem, TaskQuestion } from "./project.js";

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
});
export type WorkflowStageDef = z.infer<typeof WorkflowStageDefSchema>;

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
  stages: z.array(WorkflowStageDefSchema),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/** Id prefix marking custom (builder-authored) templates. */
export function isCustomTemplateId(id: string): boolean {
  return id.startsWith("wft_");
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
 * A builder-editable copy: fresh custom id, "(copy)" name, deep-cloned
 * stages. The duplicate of a built-in is how built-ins get customized —
 * they themselves are read-only.
 */
export function duplicateTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return {
    id: uid("wft"),
    name: `${template.name} (copy)`,
    stages: template.stages.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })),
  };
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
  stages: [
    {
      id: "refine",
      name: "Refine",
      purpose: "manage",
      dependsOn: [],
      perTrack: false,
      description: "Sharpen the goal into concrete, testable requirements with the user.",
    },
    {
      id: "plan",
      name: "Plan",
      purpose: "plan",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Break the requirements into board tasks with acceptance criteria and ordering.",
      model: "sonnet",
    },
    {
      id: "design",
      name: "Design",
      purpose: "design",
      dependsOn: ["refine"],
      perTrack: false,
      description: "Design the architecture/API/UI surface the plan builds against (parallel with Plan).",
      model: "sonnet",
    },
    {
      id: "develop",
      name: "Develop",
      purpose: "implement",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Implement each parallel track on its own branch in an isolated worktree.",
      model: "opus",
    },
    {
      id: "review",
      name: "Review",
      purpose: "code-review",
      dependsOn: ["plan", "design"],
      perTrack: true,
      description: "Review each track as its development settles; findings loop back as fixes.",
      model: "sonnet",
    },
    {
      id: "merge",
      name: "Merge",
      purpose: "merge",
      dependsOn: ["develop", "review"],
      perTrack: false,
      description: "Merge the reviewed track branches, resolve conflicts, and get tests green.",
      model: "opus",
    },
    {
      id: "release",
      name: "Release",
      purpose: "release",
      dependsOn: ["merge"],
      perTrack: false,
      description: "Release chores: changelog, version bump, tags, release notes.",
      model: "sonnet",
    },
  ],
};

/** Known templates by id. */
export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  [STANDARD_WORKFLOW_TEMPLATE.id]: STANDARD_WORKFLOW_TEMPLATE,
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
   * (raising the budget auto-resumes only budget pauses).
   */
  pausedBy: z.enum(["user", "budget"]).nullish(),
  /** Human-readable pause reason (display only — see pausedBy). */
  pausedReason: z.string().nullish(),
  /** Manager's completion summary (set via complete_workflow). */
  summary: z.string().nullish(),
  /** Spend ceiling in USD; dispatches are refused once spend crosses it. */
  budgetUsd: z.number().nullish(),
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
  for (const tag of run.tags) {
    if (isWorkflowTag(tag)) return tag.slice("workflow:".length) || null;
  }
  return null;
}

/** Every run attributed to the workflow (manager chain + workers), any status. */
export function runsForWorkflow(workflowId: string, runs: readonly AgentRun[]): AgentRun[] {
  const tag = workflowTag(workflowId);
  return runs.filter((r) => r.tags.includes(tag));
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
      state?.note ? `— ${state.note}` : null,
    ].filter(Boolean);
    lines.push(bits.join(" "));
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
        : " — no budget set"),
  );
  return lines.join("\n");
}

/**
 * The manager's kickoff prompt: the standing directive that makes one
 * interactive Claude session drive the whole workflow — refine → dispatch →
 * review → merge → release — through its MCP tools, under budget control,
 * steerable by user messages at any time.
 */
export function buildWorkflowManagerPrompt(workflow: Workflow): string {
  const template = templateOf(workflow);
  const budget =
    workflow.budgetUsd != null
      ? `Your budget is $${workflow.budgetUsd.toFixed(2)}. Check workflow_status before each wave of dispatches; once spend crosses the budget, dispatches are refused and the workflow pauses — warn the user via ask_question *before* that happens if the goal looks bigger than the budget.`
      : "No budget is set, but you still account for cost: check workflow_status between waves and prefer small, well-scoped workers.";
  const stageList = template.stages
    .map(
      (s, i) =>
        `${i + 1}. ${s.name} (${s.id}${s.perTrack ? ", per track" : ""}${s.model ? `, model: ${s.model}` : ""}) — ${s.description}`,
    )
    .join("\n");
  return [
    `You are the MANAGER of workflow "${workflow.name}" (${workflow.id}) — a long-lived, interactive coordination session. You coordinate and control; you do not implement anything yourself.`,
    "",
    `Goal:\n${workflow.goal.trim()}`,
    "",
    `Stages (template "${template.name}"; advance them with advance_stage as work moves — done stages unlock their dependents):`,
    stageList,
    "",
    "Operating protocol:",
    "- REFINE first: restate the goal as concrete, testable requirements. Use ask_question for decisions only the user can make (include your recommended default). The user can also message you directly at any time — such turns start with \"USER MESSAGE\"; treat them as steering from the owner, acknowledge, and adjust course. Mark refine done when requirements are settled enough to plan against.",
    "- PLAN + DESIGN in parallel: dispatch one worker to produce the implementation plan and, when the goal has architecture/API/UI surface, a second for design. Fold their results into the board: create_epic for the workflow, create_task per unit of work with testable acceptance criteria and blockedBy ordering.",
    "- DEVELOP + REVIEW in parallel tracks: split independent slices of the plan into tracks with add_track (each track gets its own git branch). Dispatch develop workers with isolation \"worktree\" and the track's branch so tracks never collide; set taskId on every dispatch so cost bills the right task. Tell every develop/fix worker to COMMIT its work on the track branch — worktrees are disposable, uncommitted work cannot be merged. When a track's develop worker settles, dispatch a review worker (purpose code-review) for that track while other tracks continue; review findings go back as fix workers on the same track+branch.",
    "- MERGE: when every track is reviewed and green, dispatch a merge worker (purpose merge) to merge the track branches into the main line, resolve conflicts, and get the test suite green. Mark tracks merged.",
    "- RELEASE: dispatch a release worker (purpose release) for changelog/version/tag chores, or skip the stage (advance_stage status \"skipped\") if the goal doesn't call for a release.",
    "",
    "Rules:",
    "- The board is the single source of truth. Coordinate through it: board_status, get_task, claim_task → update_task → release_task. Keep task statuses honest (in_progress when a worker starts, review when done and green, done after review).",
    `- Cost accounting is your job. ${budget}`,
    "- Model routing: pass each stage's suggested model as dispatch_worker's `model` — heavyweight models only where code gets written (develop, merge, hard fixes); lighter models for plan/design/review/release and other low-intensity work.",
    "- You are resumed automatically whenever dispatched workers settle — end your turn after dispatching instead of polling worker_status in a loop.",
    "- Record decisions as you go: advance_stage notes, task descriptions, and answers to user questions are the durable memory of this workflow.",
    "- When the goal is met — or genuinely blocked — call complete_workflow with a short summary of what shipped, what it cost, and anything left open.",
  ].join("\n");
}

/** Frame a user's interactive message for delivery into the manager session. */
export function formatUserMessage(text: string): string {
  return `USER MESSAGE:\n${text.trim()}\n\nThis is steering from the workflow's owner. Acknowledge it, adjust the plan/dispatches accordingly, and keep driving the workflow.`;
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
