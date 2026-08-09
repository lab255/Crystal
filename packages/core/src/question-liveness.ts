import { isQuestionOpen, type TaskQuestion } from "./project.js";

/**
 * Can an answer still reach whoever asked a question? Pure policy over a runs
 * index, mirroring the server's delivery mechanics so the UI can tell
 * "answering resumes an agent" from "answering goes nowhere" without a
 * round-trip. The chain resolution here MUST stay in lockstep with
 * `AgentManager.deliverToChain` (apps/server/src/agent-manager.ts): resume
 * chains via `resumedFromRunId`, fresh-session handoff forwarding via
 * `handoffFromRunId` (`forwardedChainRoot`), and the same "recorded" verdicts
 * — cancelled latest turn, or a settled chain that never got a session id.
 */

/**
 * The slice of `AgentRun` deliverability reads — fleet stores and tests can
 * pass minimal records.
 */
export interface LivenessRun {
  id: string;
  status: string;
  createdAt: string;
  sessionId?: string | null;
  resumedFromRunId?: string | null;
  handoffFromRunId?: string | null;
}

export type QuestionDeliverability = "deliverable" | "undeliverable" | "unknown";

/** Root of a run's resume chain (local generic twin of agent.ts `chainRootId`). */
function rootOf(runId: string, runsById: ReadonlyMap<string, LivenessRun>): string {
  let id = runId;
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const prev = runsById.get(id)?.resumedFromRunId;
    if (!prev) break;
    id = prev;
  }
  return id;
}

/** Every run of the chain rooted at `rootId`, oldest first. */
function chainOf(rootId: string, runsById: ReadonlyMap<string, LivenessRun>): LivenessRun[] {
  const chain: LivenessRun[] = [];
  for (const run of runsById.values()) {
    if (rootOf(run.id, runsById) === rootId) chain.push(run);
  }
  return chain.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Follow fresh-session handoffs to the chain that superseded this one — the
 * pure twin of `AgentManager.forwardedChainRoot`. A retired chain's questions
 * are answered into its continuation.
 */
function forwardedRoot(rootId: string, runsById: ReadonlyMap<string, LivenessRun>): string {
  let current = rootId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const ids = new Set(chainOf(current, runsById).map((r) => r.id));
    ids.add(current);
    const continuation = [...runsById.values()]
      .filter((run) => run.handoffFromRunId != null && ids.has(run.handoffFromRunId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!continuation) break;
    current = rootOf(continuation.id, runsById);
  }
  return current;
}

/**
 * Whether answering `q` can still reach its asking session.
 *
 * - `deliverable`: the chain is live (delivery queues and flushes on
 *   settlement) or settled with a resumable session id.
 * - `undeliverable`: no asking run recorded, the run record is definitively
 *   absent from the loaded index, the chain's latest turn was cancelled, or
 *   the chain settled without ever getting a session id. Open+undeliverable
 *   is a STALE question — answering it goes nowhere.
 * - `unknown`: the runs index is unavailable — never treat "could not read"
 *   as "dead".
 */
export function questionDeliverability(
  q: Pick<TaskQuestion, "runId">,
  runsById: ReadonlyMap<string, LivenessRun> | null | undefined,
): QuestionDeliverability {
  if (runsById == null) return "unknown";
  if (q.runId == null) return "undeliverable";
  if (!runsById.has(q.runId)) return "undeliverable";
  const rootId = forwardedRoot(rootOf(q.runId, runsById), runsById);
  const chain = chainOf(rootId, runsById);
  const latest = chain[chain.length - 1];
  if (!latest || latest.status === "cancelled") return "undeliverable";
  const live = chain.some((r) => r.status === "running" || r.status === "queued");
  if (live) return "deliverable";
  return chain.some((r) => r.sessionId) ? "deliverable" : "undeliverable";
}

/** Build the index `questionDeliverability` reads from a flat run list. */
export function livenessIndex(runs: readonly LivenessRun[]): Map<string, LivenessRun> {
  return new Map(runs.map((r) => [r.id, r]));
}

/**
 * Open questions worth counting toward "needs you": stale (open but
 * undeliverable) questions are excluded — answering them goes nowhere — while
 * `unknown` deliverability stays counted (an unreadable index is not evidence
 * of death).
 */
export function isQuestionActionable(
  q: Pick<TaskQuestion, "runId" | "answer" | "closed">,
  runsById: ReadonlyMap<string, LivenessRun> | null | undefined,
): boolean {
  return isQuestionOpen(q) && questionDeliverability(q, runsById) !== "undeliverable";
}
