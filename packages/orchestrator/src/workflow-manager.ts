import { groupRunsByManager, type AgentRun, type Workflow } from "@crystal/core";

/** A running workflow cannot receive messages when its newest manager chain died before a session existed. */
export function managerSessionEnded(
  workflowStatus: Workflow["status"],
  managerTurns: readonly AgentRun[],
): boolean {
  if (workflowStatus !== "running") return false;
  const newestFirst = [...managerTurns].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const latestChain = groupRunsByManager(newestFirst)[0];
  const latestTurn = latestChain?.run;
  return (
    latestTurn != null &&
    (latestTurn.status === "cancelled" || latestTurn.status === "failed") &&
    !latestTurn.sessionId
  );
}
