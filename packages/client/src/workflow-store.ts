import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentRun, Workflow } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * Workflows of the active workspace. The list refreshes on scope changes (the
 * provider calls `refresh`) and stays live through `workflow.changed` pushes.
 * Spend is *not* held here — it is derivable client-side from the agent
 * store's runs via `workflowSpend` (`@crystal/core`), which stays live per
 * usage event without another round-trip.
 */
export interface WorkflowState {
  workflows: Workflow[];

  refresh(): Promise<void>;
  start(input: {
    name: string;
    goal: string;
    templateId?: string;
    projectId?: string | null;
    cwd?: string;
    agentId?: string | null;
    budgetUsd?: number | null;
  }): Promise<Workflow>;
  /** Remote control: deliver a user message into the manager session. */
  message(workflowId: string, text: string): Promise<{ run: AgentRun | null; queued: boolean }>;
  setPaused(workflowId: string, paused: boolean, reason?: string | null): Promise<void>;
  setBudget(workflowId: string, budgetUsd: number | null): Promise<void>;
  cancel(workflowId: string): Promise<void>;
}

export type WorkflowStore = StoreApi<WorkflowState>;

export function createWorkflowStore(client: BridgeClient): WorkflowStore {
  const upsert = (workflow: Workflow) => {
    store.setState((s) => {
      const idx = s.workflows.findIndex((w) => w.id === workflow.id);
      if (idx === -1) return { workflows: [workflow, ...s.workflows] };
      const workflows = [...s.workflows];
      workflows[idx] = workflow;
      return { workflows };
    });
  };

  const store = createStore<WorkflowState>((set) => ({
    workflows: [],

    async refresh() {
      const { workflows } = await client.request("workflow.list", {});
      set({ workflows });
    },

    async start(input) {
      const { workflow } = await client.request("workflow.start", input);
      upsert(workflow);
      return workflow;
    },

    async message(workflowId, text) {
      return client.request("workflow.message", { workflowId, text });
    },

    async setPaused(workflowId, paused, reason) {
      const { workflow } = await client.request("workflow.setPaused", {
        workflowId,
        paused,
        reason,
      });
      upsert(workflow);
    },

    async setBudget(workflowId, budgetUsd) {
      const { workflow } = await client.request("workflow.setBudget", { workflowId, budgetUsd });
      upsert(workflow);
    },

    async cancel(workflowId) {
      const { workflow } = await client.request("workflow.cancel", { workflowId });
      upsert(workflow);
    },
  }));

  client.events.on("workflow.changed", ({ ws, workflow }) => {
    if (client.scope && ws !== client.scope) return;
    upsert(workflow);
  });

  return store;
}
