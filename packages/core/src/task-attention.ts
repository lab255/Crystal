import { runsForTask, type AgentRun } from "./agent.js";
import { recoveredRunIds } from "./attention.js";
import { PRIORITY_RANK, openQuestions, type Project, type TaskItem } from "./project.js";

/**
 * Per-task attention — the operator-style "needs your input" model. A task
 * demands attention when a run asked a question nobody answered, or when one
 * of its runs failed recoverably and nothing resumed or handed off from it.
 * The task list pins these first (longest-waiting first), the status dot
 * shows attention *over* running ("a session parked on a question is
 * technically live but really waiting on you"), and the needs-you pill
 * routes here. Pure policy — same inputs as `deriveNeedsYou`, sliced per
 * task instead of per workspace.
 *
 * Two projections live here: the full grouped task list for one board
 * (`groupTasksForList`, run-aware, blocker-aware) and the coarse
 * cross-workspace ordering the command palette uses (`taskAttention` /
 * `compareTaskAttention`), which only needs a set of live run ids per
 * workspace. Same idea — waiting on you first — at two granularities.
 */

export type TaskAttentionKind = "question" | "failure";

export interface TaskAttention {
  kinds: TaskAttentionKind[];
  /** ISO time of the oldest unanswered thing — longest-waiting sorts first. */
  waitingSince: string;
}

export function deriveTaskAttention(
  task: TaskItem,
  runs: readonly AgentRun[],
): TaskAttention | null {
  const kinds: TaskAttentionKind[] = [];
  let since: string | null = null;
  const consider = (ts: string) => {
    if (since === null || ts < since) since = ts;
  };

  const questions = openQuestions(task);
  if (questions.length > 0) {
    kinds.push("question");
    for (const q of questions) consider(q.createdAt);
  }

  const recovered = recoveredRunIds(runs);
  for (const run of runsForTask(task.id, [...runs])) {
    if (run.status === "failed" && run.failure && !recovered.has(run.id)) {
      if (!kinds.includes("failure")) kinds.push("failure");
      consider(run.endedAt ?? run.createdAt);
    }
  }

  return since !== null ? { kinds, waitingSince: since } : null;
}

/**
 * The task's dot state, attention winning over liveness: coral "waiting on
 * you" beats blue "agent working" beats idle.
 */
export type TaskPulse = "attention" | "running" | "idle";

export function taskPulse(
  task: TaskItem,
  runs: readonly AgentRun[],
  attention?: TaskAttention | null,
): TaskPulse {
  const att = attention === undefined ? deriveTaskAttention(task, runs) : attention;
  if (att) return "attention";
  const live = runs.some(
    (r) => r.taskId === task.id && (r.status === "running" || r.status === "queued"),
  );
  return live ? "running" : "idle";
}

/* ------------------------------------------------------------------ */
/* Grouped task list                                                   */
/* ------------------------------------------------------------------ */

export const TASK_LIST_GROUPS = [
  "attention",
  "in_progress",
  "review",
  "ready",
  "blocked",
  "done",
] as const;

export type TaskListGroupId = (typeof TASK_LIST_GROUPS)[number];

export const TASK_LIST_GROUP_LABELS: Record<TaskListGroupId, string> = {
  attention: "Needs your input",
  in_progress: "In progress",
  review: "Review",
  ready: "Ready",
  blocked: "Blocked",
  done: "Done",
};

export interface TaskListGroup {
  id: TaskListGroupId;
  tasks: TaskItem[];
  /** Present on the attention group — parallel to `tasks`. */
  attention?: TaskAttention[];
}

function byPriorityThenRecency(a: TaskItem, b: TaskItem): number {
  return (
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/**
 * Every task of the project in exactly one list group, attention pinned
 * first. A task with an open question or unrecovered failure leaves its
 * status group entirely (the derived group replaces the label, not
 * decorates it); done tasks never demand attention — an answered-later
 * question on a shipped task is noise, not a stopped agent. Attention is
 * ordered longest-waiting first; the rest by priority then recency; done by
 * recency alone. Empty groups are included (callers hide them) so the group
 * order is one authority.
 */
export function groupTasksForList(
  project: Project,
  runs: readonly AgentRun[],
): TaskListGroup[] {
  const byId = new Map(project.tasks.map((t) => [t.id, t]));
  const buckets: Record<TaskListGroupId, TaskItem[]> = {
    attention: [],
    in_progress: [],
    review: [],
    ready: [],
    blocked: [],
    done: [],
  };
  const attentionOf = new Map<string, TaskAttention>();

  for (const task of project.tasks) {
    const attention = task.status === "done" ? null : deriveTaskAttention(task, runs);
    if (attention) {
      attentionOf.set(task.id, attention);
      buckets.attention.push(task);
    } else if (task.status === "in_progress") {
      buckets.in_progress.push(task);
    } else if (task.status === "review") {
      buckets.review.push(task);
    } else if (task.status === "done") {
      buckets.done.push(task);
    } else {
      // Backlog: blockers decide. A blocker id matching no task is done
      // (deleted tasks must not block forever) — same rule as readyTasks.
      const blocked = task.blockedBy.some((id) => (byId.get(id)?.status ?? "done") !== "done");
      (blocked ? buckets.blocked : buckets.ready).push(task);
    }
  }

  buckets.attention.sort((a, b) =>
    attentionOf.get(a.id)!.waitingSince.localeCompare(attentionOf.get(b.id)!.waitingSince),
  );
  buckets.in_progress.sort(byPriorityThenRecency);
  buckets.review.sort(byPriorityThenRecency);
  buckets.ready.sort(byPriorityThenRecency);
  buckets.blocked.sort(byPriorityThenRecency);
  buckets.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return TASK_LIST_GROUPS.map((id) => ({
    id,
    tasks: buckets[id],
    ...(id === "attention"
      ? { attention: buckets.attention.map((t) => attentionOf.get(t.id)!) }
      : {}),
  }));
}

/** First task in grouped order — where the needs-you pill and auto-select land. */
export function firstAttentionTask(
  project: Project,
  runs: readonly AgentRun[],
): TaskItem | null {
  for (const group of groupTasksForList(project, runs)) {
    if (group.tasks.length > 0) return group.tasks[0]!;
  }
  return null;
}

/** "3m" / "2h" / "5d" — how long something has been waiting on the human. */
export function formatWaitedFor(sinceIso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(sinceIso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ------------------------------------------------------------------ */
/* Cross-workspace attention ordering (command palette)                */
/* ------------------------------------------------------------------ */

/**
 * The coarse projection for lists spanning many workspaces, where each
 * workspace contributes only its tasks and a set of live run ids. A task is
 * grouped by what it is waiting on, most human-urgent first: an open
 * question outranks everything (an agent is blocked on you), a live agent
 * run comes next (worth watching, not blocked), then the board statuses in
 * workflow order with done last.
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
