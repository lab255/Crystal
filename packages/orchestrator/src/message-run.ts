import { programIdOfRun, workflowIdOfRun, type AgentRun } from "@crystal/core";
import type { BridgeClient } from "@crystal/client";

/**
 * THE message router: deliver `text` into a run's session by whichever bridge
 * method owns that run's conversation. Routing is by attribution tag —
 * a `workflow:<id>` run is steered through its workflow manager route (which
 * adds manager-notice framing + queue persistence), a `program:<id>` run
 * through the hub's, and everything else via the generic `agent.message`
 * (verbatim `deliver` on the run's chain). One home for the decision so every
 * composer — Runs tab, Agents tab, workflow detail — steers identically.
 */
export async function messageRun(
  client: BridgeClient,
  run: AgentRun,
  text: string,
): Promise<{ queued: boolean }> {
  const workflowId = workflowIdOfRun(run);
  if (workflowId) {
    const { queued } = await client.request("workflow.message", { workflowId, text });
    return { queued };
  }
  const programId = programIdOfRun(run);
  if (programId) {
    const { queued } = await client.request("hub.message", { programId, text });
    return { queued };
  }
  const { queued } = await client.request("agent.message", { runId: run.id, text });
  return { queued };
}
