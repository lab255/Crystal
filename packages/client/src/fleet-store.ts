import { createStore, type StoreApi } from "zustand/vanilla";
import {
  DEFAULT_SERVER_SID,
  nowIso,
  type AgentRun,
  type TodoItem,
  type WorkspaceInfo,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";
import { wsKey } from "./fleet-client.js";

/** Open (unanswered) board questions across every project of a workspace. */
function countOpenQuestions(info: WorkspaceInfo): number {
  return info.projects.reduce(
    (n, p) =>
      n + p.project.tasks.reduce((m, t) => m + t.questions.filter((q) => q.answer == null).length, 0),
    0,
  );
}

/** Board writes arrive in bursts (a manager updating five tasks) — one recount each. */
const QUESTION_RECOUNT_DEBOUNCE_MS = 400;

const SAVE_DEBOUNCE_MS = 700;
const SEEN_STORAGE_KEY = "crystal.seenRuns";

/** Stable empty references for selectors (zustand v5: no literals in selectors). */
export const EMPTY_RUNS: AgentRun[] = [];
export const EMPTY_TODOS: TodoItem[] = [];

/**
 * Fleet view — cross-workspace state for the projects overview, aggregated
 * across every connected bridge server. Unlike the agent store (scoped to the
 * active workspace of the active server), this tracks every open workspace's
 * agent runs and todos so lights and counts stay live while you work
 * somewhere else.
 *
 * One instance serves the whole fleet: connections are `attach`ed as they are
 * added, and all maps are keyed by the **compound key** `"<sid>/<wsId>"`
 * (`wsKey` in fleet-client.ts) — two servers hosting the same repo path share
 * a wsId, so the bare id cannot key anything cross-server. `refresh` is
 * per-connection and only ever drops keys belonging to the server being
 * refreshed; another server's slice is never rebuilt from data it didn't
 * produce. `seenAtByWs` records when each workspace's run results were last
 * acknowledged (persisted to localStorage — per-user attention state, not
 * project data); legacy bare-wsId entries migrate one-way to the default
 * server's compound keys on first load.
 */
export interface FleetState {
  /** Keyed by `"<sid>/<wsId>"` — see `wsKey`/`parseWsKey`. */
  runsByWs: Record<string, AgentRun[]>;
  todosByWs: Record<string, TodoItem[]>;
  /**
   * Open board questions per workspace — agents waiting on the human. Drives
   * the yellow "waiting on you" attention on lights and overview cards.
   */
  questionsByWs: Record<string, number>;
  seenAtByWs: Record<string, string>;
  /** Workspace keys with an in-flight (debounced) todo save. */
  pendingTodoSaves: Record<string, true>;

  /**
   * Wire a connection's events into this store. Returns a disposer that also
   * drops the connection's slice (used when a server is removed).
   */
  attach(sid: string, client: BridgeClient): () => void;
  /**
   * Reload runs + todos for one server's workspaces. Only this server's keys
   * are replaced (its closed workspaces drop out); other servers' slices are
   * untouched.
   */
  refresh(sid: string, wsIds: string[]): Promise<void>;
  /** Optimistically set a workspace's todos and debounce-save them. */
  setTodos(key: string, items: TodoItem[]): void;
  /** Acknowledge a workspace's run results (clears its yellow/red run light). */
  markSeen(key: string): void;
  /** Fire any pending debounced todo saves now. */
  flush(): Promise<void>;
}

export type FleetStore = StoreApi<FleetState>;

/**
 * Load the persisted seen map, migrating legacy bare-wsId keys (written before
 * the fleet layer) to the default server's compound keys. One-way and
 * persisted back immediately, so the migration runs exactly once.
 */
function loadSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    let migrated = false;
    for (const [key, ts] of Object.entries(parsed)) {
      if (typeof ts !== "string") continue;
      if (key.includes("/")) {
        out[key] = ts;
      } else {
        out[wsKey(DEFAULT_SERVER_SID, key)] = ts;
        migrated = true;
      }
    }
    if (migrated) persistSeen(out);
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

export function createFleetStore(): FleetStore {
  /** Live clients by sid — how workspace-key writes find their server. */
  const clients = new Map<string, BridgeClient>();
  const clientOf = (sid: string): BridgeClient | null => clients.get(sid) ?? null;

  // Debounced save timers keyed by compound workspace key — the key (server +
  // workspace) is captured at schedule time, so a flush after the user
  // switches workspaces or servers still lands in the right place.
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function saveNow(key: string, store: FleetStore): Promise<void> {
    saveTimers.delete(key);
    const items = store.getState().todosByWs[key];
    const slash = key.indexOf("/");
    const client = clientOf(key.slice(0, slash));
    const ws = key.slice(slash + 1);
    try {
      if (items && client) await client.request("todos.save", { ws, todos: { items } });
    } finally {
      store.setState((s) => {
        const { [key]: _done, ...rest } = s.pendingTodoSaves;
        return { pendingTodoSaves: rest };
      });
    }
  }

  // Questions live on boards, and board writes ride workspace.changed —
  // debounced per workspace, and the single writer of `questionsByWs`
  // (refresh delegates here); a failed read keeps the previous count rather
  // than clearing a genuine signal.
  const questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleRecount(sid: string, ws: string): void {
    const key = wsKey(sid, ws);
    if (questionTimers.has(key)) return;
    questionTimers.set(
      key,
      setTimeout(() => {
        questionTimers.delete(key);
        clientOf(sid)
          ?.request("workspace.get", { ws })
          .then((info) => {
            const questions = countOpenQuestions(info);
            store.setState((s) =>
              s.questionsByWs[key] === questions
                ? s
                : { questionsByWs: { ...s.questionsByWs, [key]: questions } },
            );
          })
          .catch(() => {
            // workspace closed mid-flight — the next refresh drops it
          });
      }, QUESTION_RECOUNT_DEBOUNCE_MS),
    );
  }

  const store = createStore<FleetState>((set, get) => ({
    runsByWs: {},
    todosByWs: {},
    questionsByWs: {},
    seenAtByWs: typeof localStorage === "undefined" ? {} : loadSeen(),
    pendingTodoSaves: {},

    attach(sid, client) {
      clients.set(sid, client);
      const disposers = [
        // Every workspace's run changes flow in — deliberately unscoped.
        client.events.on("agent.runChanged", ({ ws, run }) => {
          const key = wsKey(sid, ws);
          store.setState((s) => {
            const runs = s.runsByWs[key] ?? [];
            const idx = runs.findIndex((r) => r.id === run.id);
            const next =
              idx === -1 ? [run, ...runs] : runs.map((r, i) => (i === idx ? run : r));
            return { runsByWs: { ...s.runsByWs, [key]: next } };
          });
        }),
        client.events.on("todos.changed", ({ ws, todos }) => {
          const key = wsKey(sid, ws);
          // Skip the echo of our own in-flight save; local state is newer.
          if (store.getState().pendingTodoSaves[key]) return;
          store.setState((s) => ({ todosByWs: { ...s.todosByWs, [key]: todos.items } }));
        }),
        client.events.on("workspace.changed", ({ ws }) => scheduleRecount(sid, ws)),
      ];
      return () => {
        for (const dispose of disposers) dispose();
        clients.delete(sid);
        // The server is gone from the fleet — its slice goes with it. Seen
        // timestamps stay (cheap, and they become live again on re-add).
        const prefix = `${sid}/`;
        const strip = <T,>(map: Record<string, T>): Record<string, T> =>
          Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)));
        set((s) => ({
          runsByWs: strip(s.runsByWs),
          todosByWs: strip(s.todosByWs),
          questionsByWs: strip(s.questionsByWs),
        }));
      };
    },

    async refresh(sid, wsIds) {
      const client = clientOf(sid);
      if (!client) return;
      const results = await Promise.all(
        wsIds.map(async (ws) => {
          const [runs, todos] = await Promise.all([
            client.request("agent.list", { ws }),
            client.request("todos.get", { ws }),
          ]);
          return { key: wsKey(sid, ws), runs: runs.runs, todos: todos.todos.items };
        }),
      );
      const prefix = `${sid}/`;
      set((s) => {
        // Rebuild only this server's slice; every other server's keys carry over.
        const runsByWs: Record<string, AgentRun[]> = Object.fromEntries(
          Object.entries(s.runsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const todosByWs: Record<string, TodoItem[]> = Object.fromEntries(
          Object.entries(s.todosByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const questionsByWs: Record<string, number> = Object.fromEntries(
          Object.entries(s.questionsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        for (const { key, runs, todos } of results) {
          runsByWs[key] = runs;
          // Carry the recount path's value; closed workspaces drop out.
          questionsByWs[key] = s.questionsByWs[key] ?? 0;
          // A pending local edit is newer than what the server just returned.
          todosByWs[key] = s.pendingTodoSaves[key] ? (s.todosByWs[key] ?? todos) : todos;
        }
        return { runsByWs, todosByWs, questionsByWs };
      });
      // Question counts have exactly ONE writer — the recount below — so a
      // slow refresh can never overwrite a fresher event-driven count with
      // data it read before the event.
      for (const ws of wsIds) scheduleRecount(sid, ws);
    },

    setTodos(key, items) {
      set((s) => ({
        todosByWs: { ...s.todosByWs, [key]: items },
        pendingTodoSaves: { ...s.pendingTodoSaves, [key]: true },
      }));
      const existing = saveTimers.get(key);
      if (existing) clearTimeout(existing);
      saveTimers.set(
        key,
        setTimeout(() => void saveNow(key, store), SAVE_DEBOUNCE_MS),
      );
    },

    markSeen(key) {
      const seen = { ...get().seenAtByWs, [key]: nowIso() };
      set({ seenAtByWs: seen });
      persistSeen(seen);
    },

    async flush() {
      const pending = [...saveTimers.keys()];
      for (const key of pending) {
        const timer = saveTimers.get(key);
        if (timer) clearTimeout(timer);
      }
      await Promise.all(pending.map((key) => saveNow(key, store)));
    },
  }));

  return store;
}
