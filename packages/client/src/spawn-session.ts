import type { BridgeClient } from "./bridge-client.js";
import type { AgentRole, BridgeMethods, RunPurpose } from "@crystal/core";

export interface SpawnSessionInput {
  client: BridgeClient;
  ws?: string;
  cwd?: string;
  repoId?: string | null;
  prompt: string;
  agentId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  tags?: string[];
  /** Existing dispatch-form fields retained when AgentsTab uses this helper. */
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  model?: string | null;
}

export type SpawnSessionResult = BridgeMethods["agent.interactive"]["result"];

/** Start a native interactive session and return its run/terminal bookkeeping. */
export async function spawnSession({
  client,
  ...params
}: SpawnSessionInput): Promise<SpawnSessionResult> {
  return client.request("agent.interactive", params);
}
