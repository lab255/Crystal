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
function recoveredRunIds(runs: readonly AgentRun[]): Set<string> {
  const recovered = new Set<string>();
  for (const run of runs) {
    if (run.resumedFromRunId) recovered.add(run.resumedFromRunId);
    if (run.handoffFromRunId) recovered.add(run.handoffFromRunId);
  }
  return recovered;
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
    .filter((r) => r.status === "failed" && r.failure && !recovered.has(r.id))
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

export function countUnrecoveredFailures(runs: readonly AgentRun[]): number {
  const recovered = recoveredRunIds(runs);
  let count = 0;
  for (const run of runs) {
    if (run.status === "failed" && run.failure && !recovered.has(run.id)) count += 1;
  }
  return count;
}
