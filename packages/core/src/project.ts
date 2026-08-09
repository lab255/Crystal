import { z } from "zod";
import { nowIso, uid } from "./ids.js";

/**
 * Project management model.
 *
 * A Project is a durable, versionable board written to
 * `.crystal/projects/*.json`. Tasks link to architecture nodes, repos and
 * files, and accumulate agent runs (run history itself is ephemeral app data,
 * only run ids are referenced here).
 */

export const TASK_STATUSES = ["backlog", "in_progress", "review", "done"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
};

export const TASK_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export const TaskSizeSchema = z.enum(TASK_SIZES);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

/** Point weights for sorting/rollups by size. */
export const TASK_SIZE_POINTS: Record<TaskSize, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

/** Every task is owned by an agent (profile id, see agent-profile.ts) AND a human. */
export const TaskOwnersSchema = z.object({
  agentId: z.string().nullish(),
  human: z.string().nullish(),
});
export type TaskOwners = z.infer<typeof TaskOwnersSchema>;

/**
 * How a question left the open state. `answered` carries the reply back to the
 * asker; `dismissed` is the human's "this no longer needs an answer";
 * `expired` is system evidence — the workflow the question belonged to reached
 * a terminal state, so its answer has nowhere to go.
 */
export const QuestionClosureSchema = z.object({
  at: z.string(),
  reason: z.enum(["answered", "dismissed", "expired"]),
  note: z.string().nullish(),
  by: z.enum(["user", "agent", "system"]),
});
export type QuestionClosure = z.infer<typeof QuestionClosureSchema>;

/**
 * An async request for user input. Agents raise these mid-run (see
 * QUESTION_MARKER in agent.ts); the human owner answers on the board, and the
 * answer resumes the originating session as a follow-up turn.
 */
export const TaskQuestionSchema = z.object({
  id: z.string(),
  /** Run that raised the question (null when asked manually). */
  runId: z.string().nullish(),
  /**
   * Durable creation attribution: the workflow the asking run belonged to
   * (from its `workflow:` tag), stamped at creation so lifecycle ties survive
   * the run and workflow records. Null workflowId = a run outside any
   * workflow; null origin = legacy or manually asked.
   */
  origin: z.object({ workflowId: z.string().nullable() }).nullish(),
  /** Who raised it — everything through MCP/broker paths is "agent". */
  askedBy: z.enum(["agent", "user"]).default("agent"),
  text: z.string(),
  /** Structured answer choices (one-click answers); free text stays allowed. */
  options: z.array(z.string()).default([]),
  /** The option the asking agent recommends (should be one of `options`). */
  recommended: z.string().nullish(),
  answer: z.string().nullish(),
  createdAt: z.string(),
  answeredAt: z.string().nullish(),
  /**
   * Lifecycle closure (see {@link QuestionClosureSchema}). Read through
   * {@link questionClosure}, never raw — legacy answered records predate this
   * field. Open = `answer == null && closed == null` ({@link isQuestionOpen}).
   */
  closed: QuestionClosureSchema.nullish(),
});
export type TaskQuestion = z.infer<typeof TaskQuestionSchema>;

/**
 * THE open-question predicate — every "waiting on you" surface derives from
 * this. Legacy precedence: a record with `answer != null` but no `closed`
 * stamp (written before closures existed) reads as closed; a `closed` stamp
 * without an answer (dismissed/expired) also reads as closed.
 */
export function isQuestionOpen(q: Pick<TaskQuestion, "answer" | "closed">): boolean {
  return q.answer == null && q.closed == null;
}

/**
 * Normalized closure accessor: the question's `closed` record, synthesizing
 * `{reason:"answered", by:"user"}` for legacy answered records that predate
 * the field. Null while the question is open. Consumers read closure through
 * this, never the raw fields.
 */
export function questionClosure(
  q: Pick<TaskQuestion, "answer" | "answeredAt" | "createdAt" | "closed">,
): QuestionClosure | null {
  if (q.closed != null) return q.closed;
  if (q.answer != null) {
    return { at: q.answeredAt ?? q.createdAt, reason: "answered", note: null, by: "user" };
  }
  return null;
}

/**
 * An exclusive write lease on a task — the board's borrow checker. One writer
 * per task: mutations must present the lease's `claimId` (a capability token
 * handed out at claim time, never listed back to other agents). Leases expire
 * (`expiresAt`, heartbeat-extended by the holder) so a crashed agent's claim
 * heals instead of deadlocking the board. Server-owned: clients cannot set or
 * clear leases through whole-project saves, only through claim/release calls.
 */
export const TaskLeaseSchema = z.object({
  /** Capability token; writes must present it. */
  claimId: z.string(),
  /** Display identity of the holder (agent profile id, run id, or "user"). */
  holder: z.string(),
  /** Run holding the lease, when an agent run claimed it. */
  holderRunId: z.string().nullish(),
  acquiredAt: z.string(),
  /** Past this instant the lease is stale and the next claimant steals it. */
  expiresAt: z.string(),
});
export type TaskLease = z.infer<typeof TaskLeaseSchema>;

/**
 * Durable cost rollup — run history is ephemeral app data, so the tokens/$ a
 * task or epic consumed are written onto the board when runs settle. Totals
 * include cache reads (they dominate real bills); `byModel` keeps the split
 * that pricing needs. Server-owned, like leases.
 */
export const CostRollupSchema = z.object({
  /** Every token, cache reads included. */
  totalTokens: z.number().default(0),
  costUsd: z.number().default(0),
  runCount: z.number().default(0),
  byModel: z
    .record(z.string(), z.object({ totalTokens: z.number(), costUsd: z.number() }))
    .default({}),
  updatedAt: z.string(),
});
export type CostRollup = z.infer<typeof CostRollupSchema>;

/** Feature epic — the grouping unit for related tasks on a board. */
export const EpicSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  /** Build cost across the epic's tasks (server-maintained, see CostRollup). */
  cost: CostRollupSchema.nullish(),
});
export type Epic = z.infer<typeof EpicSchema>;

export const TaskLinksSchema = z.object({
  /** Architecture node ids this task touches. */
  nodeIds: z.array(z.string()).default([]),
  /** Repo ids (from the workspace manifest). */
  repoIds: z.array(z.string()).default([]),
  /** Workspace-relative file paths. */
  files: z.array(z.string()).default([]),
});
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

export const TaskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  status: TaskStatusSchema.default("backlog"),
  priority: TaskPrioritySchema.default("medium"),
  /** T-shirt estimate (see TASK_SIZE_POINTS). */
  size: TaskSizeSchema.nullish(),
  /** Feature epic this task belongs to (id into Project.epics). */
  epicId: z.string().nullish(),
  /** Dimensional tags for attribution and grouping (see tags.ts). */
  labels: z.array(z.string()).default([]),
  owners: TaskOwnersSchema.default({ agentId: null, human: null }),
  links: TaskLinksSchema.default({ nodeIds: [], repoIds: [], files: [] }),
  /**
   * Prepared dispatch prompt — set when the task was minted from a plan
   * (draft refactor, promoted todo) so the queued intent survives verbatim
   * until the board dispatches it.
   */
  agentPrompt: z.string().nullish(),
  /** Task ids that must reach "done" before this one is ready to start. */
  blockedBy: z.array(z.string()).default([]),
  /** Exclusive write lease (server-maintained — see TaskLease). */
  lease: TaskLeaseSchema.nullish(),
  /** Cumulative agent cost (server-maintained — see CostRollup). */
  cost: CostRollupSchema.nullish(),
  /** Async questions for the human owner (raised by agent runs mid-task). */
  questions: z.array(TaskQuestionSchema).default([]),
  /** Agent run ids attached to this task (run records live in app data). */
  runIds: z.array(z.string()).default([]),
  /** Manual sort order within a status column. */
  order: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  epics: z.array(EpicSchema).default([]),
  tasks: z.array(TaskItemSchema).default([]),
  /**
   * Save revision, bumped by the server on every board write. Whole-project
   * saves carry the rev they were loaded at; a stale rev routes the save
   * through a per-task merge instead of a wholesale replace, so a UI snapshot
   * from before an agent's write cannot silently revert or delete it.
   */
  rev: z.number().default(0),
  /** Per-status WIP limits ("in_progress" → 3); absent means unlimited. */
  wipLimits: z.record(z.string(), z.number()).default({}),
});
export type Project = z.infer<typeof ProjectSchema>;

export function createProject(name: string): Project {
  return { id: uid("proj"), name, description: "", epics: [], tasks: [], rev: 0, wipLimits: {} };
}

export function createEpic(name: string): Epic {
  return EpicSchema.parse({ id: uid("epic"), name });
}

/** Structured-answer extras on an ask: one-click choices + a recommendation. */
export interface AskOptions {
  options?: string[];
  recommended?: string | null;
}

export function createTaskQuestion(
  text: string,
  runId?: string | null,
  opts?: AskOptions,
  meta?: {
    /** Creation attribution (see TaskQuestionSchema.origin). */
    origin?: { workflowId: string | null } | null;
    askedBy?: "agent" | "user";
  },
): TaskQuestion {
  const options = (opts?.options ?? []).map((o) => o.trim()).filter(Boolean);
  return TaskQuestionSchema.parse({
    id: uid("q"),
    runId: runId ?? null,
    origin: meta?.origin ?? null,
    askedBy: meta?.askedBy ?? "agent",
    text,
    options,
    // A recommendation that names no offered option is dropped, not trusted.
    recommended:
      opts?.recommended && options.includes(opts.recommended) ? opts.recommended : null,
    createdAt: nowIso(),
  });
}

/** Questions still waiting on the human owner. */
export function openQuestions(task: TaskItem): TaskQuestion[] {
  return task.questions.filter((q) => isQuestionOpen(q));
}

export function createTask(title: string, status: TaskStatus = "backlog"): TaskItem {
  const ts = nowIso();
  return TaskItemSchema.parse({
    id: uid("task"),
    title,
    status,
    createdAt: ts,
    updatedAt: ts,
  });
}

/** Tasks of a status column, sorted by manual order then recency. */
export function tasksInColumn(project: Project, status: TaskStatus): TaskItem[] {
  return project.tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Backlog tasks whose blockers are all done — what an orchestrator may assign
 * next, highest priority first. A blocker id that matches no task is treated
 * as done (deleted tasks must not block forever).
 */
export function readyTasks(project: Project): TaskItem[] {
  const byId = new Map(project.tasks.map((t) => [t.id, t]));
  return project.tasks
    .filter(
      (t) =>
        t.status === "backlog" &&
        t.blockedBy.every((id) => (byId.get(id)?.status ?? "done") === "done"),
    )
    .sort(
      (a, b) =>
        PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        a.order - b.order ||
        a.createdAt.localeCompare(b.createdAt),
    );
}
