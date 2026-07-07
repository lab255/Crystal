import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentRun, RunEvent, RunPurpose } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

export interface AgentStartInput {
  prompt: string;
  cwd?: string;
  taskId?: string | null;
  projectId?: string | null;
  repoId?: string | null;
  resumeSessionId?: string | null;
  isolation?: "none" | "worktree";
  /** Agent profile to dispatch to (model + skills resolve server-side). */
  agentId?: string | null;
  /** Attribution: why this run touches its task. */
  purpose?: RunPurpose | null;
  /** Dimensional tags stamped onto the run. */
  tags?: string[];
}

export interface AgentState {
  runs: AgentRun[];
  eventsByRun: Record<string, RunEvent[]>;

  refresh(): Promise<void>;
  start(input: AgentStartInput): Promise<AgentRun>;
  cancel(runId: string): Promise<void>;
  /** Load persisted events for a historical run (no-op if already loaded). */
  loadEvents(runId: string): Promise<void>;
}

export type AgentStore = StoreApi<AgentState>;

export function createAgentStore(client: BridgeClient): AgentStore {
  const store = createStore<AgentState>((set, get) => ({
    runs: [],
    eventsByRun: {},

    async refresh() {
      const { runs } = await client.request("agent.list", {});
      set({ runs });
    },

    async start(input) {
      const { run } = await client.request("agent.start", input);
      set((s) => ({
        runs: [run, ...s.runs.filter((r) => r.id !== run.id)],
        eventsByRun: { ...s.eventsByRun, [run.id]: s.eventsByRun[run.id] ?? [] },
      }));
      return run;
    },

    async cancel(runId) {
      await client.request("agent.cancel", { runId });
    },

    async loadEvents(runId) {
      if (get().eventsByRun[runId]?.length) return;
      const { events } = await client.request("agent.events", { runId });
      set((s) => {
        const existing = s.eventsByRun[runId] ?? [];
        // Live events may have raced in while we fetched; keep the longer log.
        const merged = existing.length >= events.length ? existing : events;
        return { eventsByRun: { ...s.eventsByRun, [runId]: merged } };
      });
    },
  }));

  client.events.on("agent.event", (event) => {
    store.setState((s) => {
      const existing = s.eventsByRun[event.runId] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return s;
      return {
        eventsByRun: { ...s.eventsByRun, [event.runId]: [...existing, event] },
      };
    });
  });

  client.events.on("agent.runChanged", ({ ws, run }) => {
    // Runs list is scoped to the active workspace; ignore other workspaces'.
    if (client.scope && ws !== client.scope) return;
    store.setState((s) => {
      const idx = s.runs.findIndex((r) => r.id === run.id);
      if (idx === -1) return { runs: [run, ...s.runs] };
      const runs = [...s.runs];
      runs[idx] = run;
      return { runs };
    });
  });

  return store;
}
