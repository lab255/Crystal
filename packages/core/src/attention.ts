import type { AgentRun, AgentRunStatus } from "./agent.js";
import { openQuestions, type Project, type TaskQuestion } from "./project.js";
import type { RunFailure } from "./run-failure.js";
import { todosLight, worstLight, type TodoItem, type TrafficLight } from "./todo.js";

/**
 * THE workspace attention policy — every surface that tells the human "this
 * needs you" derives from this file, so the Overview cards, the workspace-tab
 * lights, the fleet rail dot, the orchestrator pill and the rail badge can
 * never disagree about what is waiting. Three lanes, each with its own way of
 * clearing:
 *
 * - **Attention** ("needs you"): open board questions + recoverable-failed
 *   runs no later run has recovered (see run-failure.ts). An agent is stopped
 *   until a human acts, so this lane clears only by answering the question or
 *   recovering the run — never by acknowledgement.
 * - **Review**: runs that settled after the workspace was last looked at
 *   (`seenAt`) — results to skim, red when the run failed. Acknowledgeable:
 *   focusing the workspace (`markSeen`) clears it.
 * - **Todos** are a separate, manual lane (todo.ts); they join only in the
 *   `workspaceLight` rollup.
 */

/* ------------------------------------------------------------------ *
 * Needs you — the attention lane, itemized (pill, badge, task lists). *
 * ------------------------------------------------------------------ */

export interface NeedsYouQuestion {
  projectPath: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  question: TaskQuestion;
}

export interface NeedsYou {
  questions: NeedsYouQuestion[];
  /** Recoverable-failed runs still awaiting recovery, newest first. */
  failures: AgentRun[];
  count: number;
}

export type ProjectEntry = { path: string; project: Project };

/**
 * The structural slice of `AgentRun` the policy reads — fleet lists and tests
 * can pass minimal records.
 */
export interface AttentionRun {
  id: string;
  status: AgentRunStatus;
  endedAt?: string | null;
  failure?: RunFailure | null;
  resumedFromRunId?: string | null;
  handoffFromRunId?: string | null;
}

/** A failure counts as recovered once any run resumes or hands off from it. */
function recoveredRunIds(runs: readonly AttentionRun[]): Set<string> {
  const recovered = new Set<string>();
  for (const run of runs) {
    if (run.resumedFromRunId) recovered.add(run.resumedFromRunId);
    if (run.handoffFromRunId) recovered.add(run.handoffFromRunId);
  }
  return recovered;
}

function isUnrecoveredFailure(run: AttentionRun, recovered: ReadonlySet<string>): boolean {
  return run.status === "failed" && run.failure != null && !recovered.has(run.id);
}

export function deriveNeedsYou(
  projects: readonly ProjectEntry[],
  runs: readonly AgentRun[],
): NeedsYou {
  const questions: NeedsYouQuestion[] = [];
  for (const { path, project } of projects) {
    for (const task of project.tasks) {
      for (const question of openQuestions(task)) {
        questions.push({
          projectPath: path,
          projectName: project.name,
          taskId: task.id,
          taskTitle: task.title,
          question,
        });
      }
    }
  }
  const recovered = recoveredRunIds(runs);
  const failures = runs
    .filter((r) => isUnrecoveredFailure(r, recovered))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { questions, failures, count: questions.length + failures.length };
}

/* Count-only variants: primitives, safe to call inside zustand selectors so
   hot components (the app shell) re-render on count changes, not on every
   stream event that replaces the runs array. */

export function countOpenQuestions(projects: readonly ProjectEntry[]): number {
  let count = 0;
  for (const { project } of projects) {
    for (const task of project.tasks) count += openQuestions(task).length;
  }
  return count;
}

export function countUnrecoveredFailures(runs: readonly AttentionRun[]): number {
  const recovered = recoveredRunIds(runs);
  let count = 0;
  for (const run of runs) {
    if (isUnrecoveredFailure(run, recovered)) count += 1;
  }
  return count;
}

/* ------------------------------------------------------- *
 * Run summary + traffic lights (cards, tab dots, rail dot) *
 * ------------------------------------------------------- */

export interface RunAttention {
  /** Runs executing or queued — work in flight, all good. */
  running: number;
  /** Attention lane: unrecovered recoverable failures. Clears by recovery, never `markSeen`. */
  failures: number;
  /** Review lane: non-failed runs settled after `seenAt`. Clears on `markSeen`. */
  review: number;
  /** Review lane, failed: settled-unseen failures not already in `failures`. */
  reviewFailed: number;
  /** Rollup of the run lanes (questions and todos join in the functions below). */
  light: TrafficLight;
}

/**
 * Fold a workspace's runs into the two run lanes. Cancellations were
 * user-initiated, so they never surface; an unrecovered recoverable failure is
 * attention no matter how long ago it was acknowledged.
 */
export function deriveRunAttention(
  runs: readonly AttentionRun[],
  seenAt: string | null,
): RunAttention {
  const recovered = recoveredRunIds(runs);
  let running = 0;
  let failures = 0;
  let review = 0;
  let reviewFailed = 0;
  for (const run of runs) {
    if (run.status === "running" || run.status === "queued") running += 1;
    else if (run.status === "cancelled") continue;
    else if (isUnrecoveredFailure(run, recovered)) failures += 1;
    else if (run.endedAt && (!seenAt || run.endedAt > seenAt)) {
      if (run.status === "failed") reviewFailed += 1;
      else review += 1;
    }
  }
  const light: TrafficLight =
    failures > 0 || reviewFailed > 0
      ? "red"
      : review > 0
        ? "yellow"
        : running > 0
          ? "green"
          : "gray";
  return { running, failures, review, reviewFailed, light };
}

/**
 * Run lanes + open board questions. A question is an agent stopped on a
 * decision only a human can make — yellow (nothing is broken), and it clears
 * only by answering, never by acknowledgement.
 */
export function attentionLight(
  runs: readonly AttentionRun[],
  seenAt: string | null,
  openQuestionCount = 0,
): TrafficLight {
  return worstLight([
    deriveRunAttention(runs, seenAt).light,
    openQuestionCount > 0 ? "yellow" : "gray",
  ]);
}

/** Overall workspace light: todos + run lanes + open questions, worst wins. */
export function workspaceLight(
  todos: TodoItem[],
  runs: readonly AttentionRun[],
  seenAt: string | null,
  openQuestionCount = 0,
): TrafficLight {
  return worstLight([todosLight(todos), attentionLight(runs, seenAt, openQuestionCount)]);
}
