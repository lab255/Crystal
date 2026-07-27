import { chainRootId, type AgentRun } from "@crystal/core";

/**
 * The resume lineage `run` belongs to — every turn of one logical Claude
 * session, oldest first. This is the one client-side chain derivation: the
 * hub and workflow turn strips hand-derive theirs by tag filter + sort today,
 * and both converge on this instead.
 *
 * Membership is the transitive closure over two kinds of evidence:
 * - `resumedFromRunId` links (the server stamps them on every wake-up /
 *   user-message resume — see `chainRootId` in core), and
 * - `sessionId` equality, because some resume paths carry only the session
 *   (an agent-console turn starts with `resumeSessionId` and no run link).
 *
 * `parentRunId` is deliberately *not* chain evidence: it is the
 * manager→worker hierarchy — a worker is a different agent, not a turn of
 * its manager's session.
 */
export function chainOf(runs: readonly AgentRun[], run: AgentRun): AgentRun[] {
  const byId = new Map<string, AgentRun>(runs.map((r) => [r.id, r]));
  byId.set(run.id, run); // the anchor belongs even if absent from the list

  const roots = new Set<string>([chainRootId(run.id, byId)]);
  const sessions = new Set<string>();
  if (run.sessionId) sessions.add(run.sessionId);

  const members = new Map<string, AgentRun>([[run.id, run]]);
  /** Ids the current members resumed from — direct-link evidence that stays
   * sound even when corrupt data (a resume cycle) confuses the root walk. */
  const resumedFrom = new Set<string>();
  if (run.resumedFromRunId) resumedFrom.add(run.resumedFromRunId);

  // Fixed point: adopting a run can reveal a new root or session id that
  // pulls further runs in (session evidence bridges runs whose resume links
  // point at records we've not adopted yet).
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of byId.values()) {
      if (members.has(r.id)) continue;
      const linked =
        roots.has(chainRootId(r.id, byId)) ||
        (r.sessionId != null && sessions.has(r.sessionId)) ||
        (r.resumedFromRunId != null && members.has(r.resumedFromRunId)) ||
        resumedFrom.has(r.id);
      if (!linked) continue;
      members.set(r.id, r);
      roots.add(chainRootId(r.id, byId));
      if (r.sessionId) sessions.add(r.sessionId);
      if (r.resumedFromRunId) resumedFrom.add(r.resumedFromRunId);
      grew = true;
    }
  }

  return [...members.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
