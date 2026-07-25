import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentRun, TemplateScope, Workflow, WorkflowTemplate } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * Workflows of the active workspace. The list refreshes on scope changes (the
 * provider calls `refresh`) and stays live through `workflow.changed` pushes.
 * Spend is *not* held here — it is derivable client-side from the agent
 * store's runs via `workflowSpend` (`@crystal/core`), which stays live per
 * usage event without another round-trip. Templates (built-in + custom) ride
 * along for the builder and the start panel, live via
 * `workflow.templatesChanged`.
 */
export interface WorkflowState {
  workflows: Workflow[];
  /** Selectable templates: built-ins first, then global library, then project. */
  templates: WorkflowTemplate[];

  refresh(): Promise<void>;
  start(input: {
    name: string;
    goal: string;
    templateId?: string;
    /** A graph for this run only (start panel's "customise for this run"). */
    template?: WorkflowTemplate | null;
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
  /**
   * Create/update a custom template (server validates; returns the saved
   * form). `scope` overrides where it is stored — passing one that differs
   * from the template's current scope moves it between the shared global
   * library and this project.
   */
  saveTemplate(
    template: WorkflowTemplate,
    scope?: Exclude<TemplateScope, "builtin">,
  ): Promise<WorkflowTemplate>;
  deleteTemplate(templateId: string): Promise<void>;
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

  const refreshTemplates = async () => {
    const { templates } = await client.request("workflow.templates", {});
    store.setState({ templates });
  };

  const store = createStore<WorkflowState>((set) => ({
    workflows: [],
    templates: [],

    async refresh() {
      const [{ workflows }, { templates }] = await Promise.all([
        client.request("workflow.list", {}),
        client.request("workflow.templates", {}),
      ]);
      set({ workflows, templates });
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

    async saveTemplate(template, scope) {
      const { template: saved } = await client.request("workflow.saveTemplate", { template, scope });
      // The templatesChanged push also lands; updating eagerly keeps the
      // builder responsive when the round-trip beats the broadcast.
      set((s) => {
        const idx = s.templates.findIndex((t) => t.id === saved.id);
        if (idx === -1) return { templates: [...s.templates, saved] };
        const templates = [...s.templates];
        templates[idx] = saved;
        return { templates };
      });
      return saved;
    },

    async deleteTemplate(templateId) {
      await client.request("workflow.deleteTemplate", { templateId });
      set((s) => ({ templates: s.templates.filter((t) => t.id !== templateId) }));
    },
  }));

  client.events.on("workflow.changed", ({ ws, workflow }) => {
    if (client.scope && ws !== client.scope) return;
    upsert(workflow);
  });

  client.events.on("workflow.templatesChanged", ({ ws }) => {
    if (client.scope && ws !== client.scope) return;
    void refreshTemplates();
  });

  return store;
}
