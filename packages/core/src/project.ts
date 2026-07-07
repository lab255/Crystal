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
 * An async request for user input. Agents raise these mid-run (see
 * QUESTION_MARKER in agent.ts); the human owner answers on the board, and the
 * answer resumes the originating session as a follow-up turn.
 */
export const TaskQuestionSchema = z.object({
  id: z.string(),
  /** Run that raised the question (null when asked manually). */
  runId: z.string().nullish(),
  text: z.string(),
  answer: z.string().nullish(),
  createdAt: z.string(),
  answeredAt: z.string().nullish(),
});
export type TaskQuestion = z.infer<typeof TaskQuestionSchema>;

/** Feature epic — the grouping unit for related tasks on a board. */
export const EpicSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
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
});
export type Project = z.infer<typeof ProjectSchema>;

export function createProject(name: string): Project {
  return { id: uid("proj"), name, description: "", epics: [], tasks: [] };
}

export function createEpic(name: string): Epic {
  return EpicSchema.parse({ id: uid("epic"), name });
}

export function createTaskQuestion(text: string, runId?: string | null): TaskQuestion {
  return TaskQuestionSchema.parse({
    id: uid("q"),
    runId: runId ?? null,
    text,
    createdAt: nowIso(),
  });
}

/** Questions still waiting on the human owner. */
export function openQuestions(task: TaskItem): TaskQuestion[] {
  return task.questions.filter((q) => q.answer == null);
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
