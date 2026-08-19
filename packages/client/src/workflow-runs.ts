import {
  groupRunsByManager,
  sessionWorkflowId,
  type AgentRun,
  type RunNode,
} from "@crystal/core";

/**
 * Sessions attributed to a workflow, preserving manager/worker parentage.
 * A matching session below an untagged or foreign parent is promoted to the
 * nearest visible level so incomplete legacy attribution never hides it.
 */
export function workflowRunForest(
  runs: readonly AgentRun[],
  workflowId: string,
): RunNode[] {
  const promoteMatches = (node: RunNode): RunNode[] => {
    const workers = node.workers.flatMap(promoteMatches);
    if (sessionWorkflowId(node) !== workflowId) return workers;
    return [{ ...node, workers }];
  };

  return groupRunsByManager([...runs])
    .flatMap(promoteMatches)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aManager = a.node.turns.some((turn) => turn.role === "manager") ? 0 : 1;
      const bManager = b.node.turns.some((turn) => turn.role === "manager") ? 0 : 1;
      return aManager - bManager || a.index - b.index;
    })
    .map(({ node }) => node);
}
