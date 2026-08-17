/**
 * Display semantics for the session forest. `groupRunsByManager` (agent.ts)
 * builds the tree; this module is the one vocabulary every surface that
 * *renders* it shares — rail cards, run lists, workflow worker trees. Three
 * different status encodings (raw AgentRunStatus, working/idle, workflow chip
 * classes) once let the same run look healthy in one tab and stalled in
 * another; new surfaces derive from here instead of inventing a fourth.
 */
import type { AgentRun, RunNode } from "./agent.js";
import type { NeedsYou } from "./attention.js";
import { tagsInDimension } from "./tags.js";

/**
 * One session's rolled-up display status, in precedence order:
 *
 * - `needs-you` — a turn anywhere in the subtree is waiting on the operator
 *   (open question, parked permission, unrecovered recoverable failure).
 *   Outranks `working`: a subtree with one streaming worker and one blocked
 *   worker is actionable, and "working" would hide that.
 * - `working` — any session in the subtree has a queued/running turn.
 * - `failed` — the subtree settled and some session's latest turn failed.
 * - `idle` — settled, nothing owed in either direction.
 */
export type SessionDisplayStatus = "needs-you" | "working" | "failed" | "idle";

/**
 * The run ids `deriveNeedsYou` found actionable — the join key between the
 * attention policy (attention.ts) and the session tree. Questions asked
 * manually (`runId` null) belong to no session and are skipped.
 */
export function attentionRunIds(needsYou: NeedsYou): Set<string> {
  const ids = new Set<string>();
  for (const row of needsYou.questions) {
    if (row.question.runId) ids.add(row.question.runId);
  }
  for (const permission of needsYou.permissions) ids.add(permission.runId);
  for (const failure of needsYou.failures) ids.add(failure.id);
  return ids;
}

function subtreeSome(node: RunNode, pred: (node: RunNode) => boolean): boolean {
  return pred(node) || node.workers.some((worker) => subtreeSome(worker, pred));
}

/**
 * Roll one session subtree up to a {@link SessionDisplayStatus}. Pass the
 * workspace's {@link attentionRunIds}; pass an empty set when the attention
 * feed is unavailable — unknown attention degrades to `working`/`idle`,
 * never to a false "needs you".
 */
export function sessionDisplayStatus(
  node: RunNode,
  attention: ReadonlySet<string>,
): SessionDisplayStatus {
  if (subtreeSome(node, (n) => n.turns.some((turn) => attention.has(turn.id)))) {
    return "needs-you";
  }
  if (
    subtreeSome(node, (n) => n.run.status === "running" || n.run.status === "queued")
  ) {
    return "working";
  }
  if (subtreeSome(node, (n) => n.run.status === "failed")) return "failed";
  return "idle";
}

/**
 * Total spend of a session subtree — every turn of every nested session — or
 * null when NO turn has a readable cost. "$0.00" and "could not be read" are
 * different facts (interactive runs stream no usage); collapsing both to 0
 * once made an uncapped interactive fleet look free.
 */
export function sessionSubtreeCost(node: RunNode): number | null {
  let total: number | null = null;
  for (const turn of node.turns) {
    if (turn.costUsd != null) total = (total ?? 0) + turn.costUsd;
  }
  for (const worker of node.workers) {
    const nested = sessionSubtreeCost(worker);
    if (nested != null) total = (total ?? 0) + nested;
  }
  return total;
}

/** Sessions nested under this one, at any depth. */
export function sessionDescendantCount(node: RunNode): number {
  return node.workers.reduce(
    (count, worker) => count + 1 + sessionDescendantCount(worker),
    0,
  );
}

/** The newest activity stamp in the subtree — rails sort/relabel by this. */
export function sessionLatestActivity(node: RunNode): string {
  let latest = "";
  for (const turn of node.turns) {
    for (const stamp of [turn.createdAt, turn.endedAt ?? ""]) {
      if (stamp > latest) latest = stamp;
    }
  }
  for (const worker of node.workers) {
    const stamp = sessionLatestActivity(worker);
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

/** The run's `workflow:<id>` attribution, or null outside any workflow. */
export function runWorkflowId(run: Pick<AgentRun, "tags">): string | null {
  return tagsInDimension(run.tags, "workflow")[0] ?? null;
}

/**
 * The session's workflow attribution: the first turn that carries a
 * `workflow:` tag decides (dispatched turns are stamped at creation, so a
 * chain never straddles workflows in practice).
 */
export function sessionWorkflowId(node: RunNode): string | null {
  for (const turn of node.turns) {
    const id = runWorkflowId(turn);
    if (id) return id;
  }
  return null;
}
