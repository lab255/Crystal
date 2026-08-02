import type { AgentRun } from "./agent.js";
import { PRIORITY_RANK, openQuestions, type TaskItem } from "./project.js";

/**
 * Attention grouping over board tasks — the one ordering every "jump to a
 * task" surface shares (command palette, future notification lists). A task
 * is grouped by what it is waiting on, most human-urgent first: an open
 * question outranks everything (an agent is blocked on you), a live agent run
 * comes next (worth watching, not blocked), then the board statuses in
 * workflow order with done last. Pure policy — callers bind it to whichever
 * run list matches the task's workspace.
 */

/** Descending urgency — index order doubles as sort rank. */
export const TASK_ATTENTION_GROUPS = [
  "waiting",
  "running",
  "review",
  "in_progress",
  "backlog",
  "done",
] as const;
export type TaskAttentionGroup = (typeof TASK_ATTENTION_GROUPS)[number];

export const TASK_ATTENTION_LABELS: Record<TaskAttentionGroup, string> = {
  waiting: "Waiting on you",
  running: "Agent running",
  review: "In review",
  in_progress: "In progress",
  backlog: "Backlog",
  done: "Done",
};

const GROUP_RANK = Object.fromEntries(TASK_ATTENTION_GROUPS.map((g, i) => [g, i])) as Record<
  TaskAttentionGroup,
  number
>;

/** Ids of runs still executing — the "running" signal for `taskAttention`. */
export function liveRunIds(runs: readonly Pick<AgentRun, "id" | "status">[]): Set<string> {
  const live = new Set<string>();
  for (const run of runs) {
    if (run.status === "running" || run.status === "queued") live.add(run.id);
  }
  return live;
}

/**
 * Which attention group one task falls in. An open question wins even on a
 * done task — the question clears only by answering, same rule as the
 * workspace traffic light (`questionsLight`).
 */
export function taskAttention(task: TaskItem, live: ReadonlySet<string>): TaskAttentionGroup {
  if (openQuestions(task).length > 0) return "waiting";
  if (task.runIds.some((id) => live.has(id))) return "running";
  if (task.status === "review") return "review";
  if (task.status === "in_progress") return "in_progress";
  if (task.status === "done") return "done";
  return "backlog";
}

/**
 * Attention order for pre-grouped entries: group rank, then priority, then
 * recency. Takes the group alongside the task so lists spanning several
 * workspaces (each with its own live-run set) can sort in one pass.
 */
export function compareTaskAttention(
  a: { group: TaskAttentionGroup; task: TaskItem },
  b: { group: TaskAttentionGroup; task: TaskItem },
): number {
  return (
    GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
    PRIORITY_RANK[b.task.priority] - PRIORITY_RANK[a.task.priority] ||
    b.task.updatedAt.localeCompare(a.task.updatedAt)
  );
}

/** One board's tasks in attention order (see `compareTaskAttention`). */
export function sortTasksByAttention(
  tasks: readonly TaskItem[],
  live: ReadonlySet<string>,
): TaskItem[] {
  return tasks
    .map((task) => ({ group: taskAttention(task, live), task }))
    .sort(compareTaskAttention)
    .map((e) => e.task);
}
