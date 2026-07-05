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
  labels: z.array(z.string()).default([]),
  links: TaskLinksSchema.default({ nodeIds: [], repoIds: [], files: [] }),
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
  tasks: z.array(TaskItemSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export function createProject(name: string): Project {
  return { id: uid("proj"), name, description: "", tasks: [] };
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
