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
