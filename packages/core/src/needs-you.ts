import type { AgentRun } from "./agent.js";
import { openQuestions, type Project, type TaskQuestion } from "./project.js";

/**
 * "Needs you" — everything in a workspace waiting on the human: open task
 * questions, and failed runs classified as recoverable (see run-failure.ts)
 * that no later run has recovered. Pure policy; the client hook
 * (`useNeedsYou` in @crystal/client) and any server-side consumer derive
 * from here so the badge, the pill and future notifications can never drift.
 */

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

/** A failure counts as recovered once any run resumes or hands off from it. */
export function recoveredRunIds(runs: readonly AgentRun[]): Set<string> {
  const recovered = new Set<string>();
  for (const run of runs) {
    if (run.resumedFromRunId) recovered.add(run.resumedFromRunId);
    if (run.handoffFromRunId) recovered.add(run.handoffFromRunId);
  }
  return recovered;
}

/** All of a workspace's open questions as NeedsYou entries (task context attached). */
export function needsYouQuestions(projects: readonly ProjectEntry[]): NeedsYouQuestion[] {
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
  return questions;
}

/** Recoverable-failed runs no later run has recovered, newest first. */
export function unrecoveredFailures(runs: readonly AgentRun[]): AgentRun[] {
  const recovered = recoveredRunIds(runs);
  return runs
    .filter((r) => r.status === "failed" && r.failure && !recovered.has(r.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deriveNeedsYou(
  projects: readonly ProjectEntry[],
  runs: readonly AgentRun[],
): NeedsYou {
  const questions = needsYouQuestions(projects);
  const failures = unrecoveredFailures(runs);
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

export function countUnrecoveredFailures(runs: readonly AgentRun[]): number {
  const recovered = recoveredRunIds(runs);
  let count = 0;
  for (const run of runs) {
    if (run.status === "failed" && run.failure && !recovered.has(run.id)) count += 1;
  }
  return count;
}

/* Attention transitions — the notification policy. */

/** Stable notification identity of a waiting question (question ids are unique per ask). */
export function questionAttentionId(question: TaskQuestion): string {
  return `q:${question.id}`;
}

/** Stable notification identity of an unrecovered failure (recovery always spawns a new run id). */
export function failureAttentionId(run: AgentRun): string {
  return `f:${run.id}`;
}

/**
 * Transition detector behind "new attention" notifications (operator-oss's
 * useOrchestrator seeding pattern): feed each source's successive snapshots of
 * waiting-item ids; a source's FIRST snapshot seeds silently, so a page reload
 * never re-announces what was already waiting — only ids that appear on a
 * later snapshot come back as new. Sources seed independently because their
 * data arrives at different times (a workspace's runs land with the fleet
 * refresh; its question list only after the debounced board recount) — one
 * shared seed flag would misread the late-arriving half as a transition.
 * Seen ids are never forgotten: an item leaving and returning under the same
 * id (impossible today — answers and recoveries both mint new ids) is quieter
 * than a duplicate announcement.
 */
export class AttentionTracker {
  private readonly seen = new Set<string>();
  private readonly seeded = new Set<string>();

  /** Returns the ids new since `source`'s last snapshot (empty on its seeding call). */
  next(source: string, ids: readonly string[]): string[] {
    if (!this.seeded.has(source)) {
      this.seeded.add(source);
      for (const id of ids) this.seen.add(id);
      return [];
    }
    const fresh = ids.filter((id) => !this.seen.has(id));
    for (const id of fresh) this.seen.add(id);
    return fresh;
  }
}
