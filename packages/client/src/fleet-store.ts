import { createStore, type StoreApi } from "zustand/vanilla";
import { nowIso, type AgentRun, type TodoItem } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

const SAVE_DEBOUNCE_MS = 700;
const SEEN_STORAGE_KEY = "crystal.seenRuns";

/** Stable empty references for selectors (zustand v5: no literals in selectors). */
export const EMPTY_RUNS: AgentRun[] = [];
export const EMPTY_TODOS: TodoItem[] = [];

/**
 * Fleet view — cross-workspace state for the projects overview. Unlike the
 * agent store (scoped to the active workspace), this tracks every open
 * workspace's agent runs and todos so lights and counts stay live while you
 * work somewhere else. `seenAtByWs` records when each workspace's run results
 * were last acknowledged (persisted to localStorage — it's per-user attention
 * state, not project data).
 */
export interface FleetState {
  runsByWs: Record<string, AgentRun[]>;
  todosByWs: Record<string, TodoItem[]>;
  seenAtByWs: Record<string, string>;
  /** Workspaces with an in-flight (debounced) todo save. */
  pendingTodoSaves: Record<string, true>;

  /** Reload runs + todos for the given workspace ids (drops closed ones). */
  refresh(wsIds: string[]): Promise<void>;
  /** Optimistically set a workspace's todos and debounce-save them. */
  setTodos(ws: string, items: TodoItem[]): void;
  /** Acknowledge a workspace's run results (clears its yellow/red run light). */
  markSeen(ws: string): void;
  /** Fire any pending debounced todo saves now. */
  flush(): Promise<void>;
}

export type FleetStore = StoreApi<FleetState>;

function loadSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [ws, ts] of Object.entries(parsed)) {
      if (typeof ts === "string") out[ws] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function persistSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* storage unavailable — seen state is per-session then */
  }
}

export function createFleetStore(client: BridgeClient): FleetStore {
  // Debounced save timers keyed by workspace id — the ws is captured at
  // schedule time, so a flush after the user switches workspaces still lands
  // in the right one.
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function saveNow(ws: string, store: FleetStore): Promise<void> {
    saveTimers.delete(ws);
    const items = store.getState().todosByWs[ws];
    if (!items) return;
    try {
      await client.request("todos.save", { ws, todos: { items } });
    } finally {
      store.setState((s) => {
        const { [ws]: _done, ...rest } = s.pendingTodoSaves;
        return { pendingTodoSaves: rest };
      });
    }
  }

  const store = createStore<FleetState>((set, get) => ({
    runsByWs: {},
    todosByWs: {},
    seenAtByWs: typeof localStorage === "undefined" ? {} : loadSeen(),
    pendingTodoSaves: {},

    async refresh(wsIds) {
      const results = await Promise.all(
        wsIds.map(async (ws) => {
          const [runs, todos] = await Promise.all([
            client.request("agent.list", { ws }),
            client.request("todos.get", { ws }),
          ]);
          return { ws, runs: runs.runs, todos: todos.todos.items };
        }),
      );
      set((s) => {
        const runsByWs: Record<string, AgentRun[]> = {};
        const todosByWs: Record<string, TodoItem[]> = {};
        for (const { ws, runs, todos } of results) {
          runsByWs[ws] = runs;
          // A pending local edit is newer than what the server just returned.
          todosByWs[ws] = s.pendingTodoSaves[ws] ? (s.todosByWs[ws] ?? todos) : todos;
        }
        return { runsByWs, todosByWs };
      });
    },

    setTodos(ws, items) {
      set((s) => ({
        todosByWs: { ...s.todosByWs, [ws]: items },
        pendingTodoSaves: { ...s.pendingTodoSaves, [ws]: true },
      }));
      const existing = saveTimers.get(ws);
      if (existing) clearTimeout(existing);
      saveTimers.set(
        ws,
        setTimeout(() => void saveNow(ws, store), SAVE_DEBOUNCE_MS),
      );
    },

    markSeen(ws) {
      const seen = { ...get().seenAtByWs, [ws]: nowIso() };
      set({ seenAtByWs: seen });
      persistSeen(seen);
    },

    async flush() {
      const pending = [...saveTimers.keys()];
      for (const ws of pending) {
        const timer = saveTimers.get(ws);
        if (timer) clearTimeout(timer);
      }
      await Promise.all(pending.map((ws) => saveNow(ws, store)));
    },
  }));

  // Every workspace's run changes flow in — this store is deliberately unscoped.
  client.events.on("agent.runChanged", ({ ws, run }) => {
    store.setState((s) => {
      const runs = s.runsByWs[ws] ?? [];
      const idx = runs.findIndex((r) => r.id === run.id);
      const next = idx === -1 ? [run, ...runs] : runs.map((r, i) => (i === idx ? run : r));
      return { runsByWs: { ...s.runsByWs, [ws]: next } };
    });
  });

  client.events.on("todos.changed", ({ ws, todos }) => {
    // Skip the echo of our own in-flight save; local state is newer.
    if (store.getState().pendingTodoSaves[ws]) return;
    store.setState((s) => ({ todosByWs: { ...s.todosByWs, [ws]: todos.items } }));
  });

  return store;
}
