import { createStore, type StoreApi } from "zustand/vanilla";
import {
  DEFAULT_SERVER_SID,
  livenessIndex,
  needsYouQuestions,
  nowIso,
  questionDeliverability,
  type AgentRun,
  type RunEvent,
  type Workflow,
  type NeedsYouQuestion,
  type PendingPermission,
  type ProjectEntry,
  type QuestionDeliverability,
  type TodoItem,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";
import { runKey, wsKey } from "./fleet-client.js";

/** Board writes arrive in bursts (a manager updating five tasks) — one recount each. */
const QUESTION_RECOUNT_DEBOUNCE_MS = 400;

const SAVE_DEBOUNCE_MS = 700;
const SEEN_STORAGE_KEY = "crystal.seenRuns";

/** Stable empty references for selectors (zustand v5: no literals in selectors). */
export const EMPTY_RUNS: AgentRun[] = [];
export const EMPTY_TODOS: TodoItem[] = [];
export const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
export const EMPTY_WORKFLOWS: Workflow[] = [];
export const EMPTY_EVENTS: RunEvent[] = [];

/** An open fleet question with liveness resolved from that workspace's run snapshot. */
export type FleetQuestion = NeedsYouQuestion & { deliverability: QuestionDeliverability };

export const EMPTY_QUESTIONS: FleetQuestion[] = [];

/**
 * Annotate open question rows without churning a selector-visible reference.
 * Question identity + deliverability are the observable fleet contract: board
 * recounts with the same set, and run updates that do not change a verdict,
 * are no-ops even when their input arrays were replaced.
 */
export function annotateFleetQuestions(
  questions: readonly NeedsYouQuestion[],
  runs: readonly AgentRun[] | undefined,
  previous?: readonly FleetQuestion[],
): FleetQuestion[] {
  const runsById = runs === undefined ? null : livenessIndex(runs);
  const annotated = questions.map((row) => ({
    ...row,
    deliverability: questionDeliverability(row.question, runsById),
  }));
  if (previous && previous.length === annotated.length) {
    const nextById = new Map(
      annotated.map((row) => [row.question.id, row.deliverability] as const),
    );
    const same = previous.every(
      (row) => nextById.get(row.question.id) === row.deliverability,
    );
    if (same) return previous as FleetQuestion[];
  }
  return annotated;
}

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
  /** A run event can arrive before the complete `agent.list` snapshot. */
  runsLoadedByWs: Record<string, true>;
  workflowsByWs: Record<string, Workflow[]>;
  eventsByRunKey: Record<string, RunEvent[]>;
  todosByWs: Record<string, TodoItem[]>;
  /**
   * Open board questions per workspace — agents waiting on the human, with
   * the task context needed to jump to them. Drives the yellow "waiting on
   * you" attention on lights and overview cards (via the core actionable-row
   * counter) and the shell's cross-workspace needs-you pill. Stale rows remain
   * here for inboxes. A key absent from this map means
   * "not read yet", not "no questions" — the attention notifier seeds on
   * first read (see AttentionTracker in @crystal/core).
   */
  questionsByWs: Record<string, FleetQuestion[]>;
  /** Tool calls parked on an owner decision, keyed by compound workspace key. */
  permissionsByWs: Record<string, PendingPermission[]>;
  /**
   * Project boards per workspace — what cross-workspace surfaces (the command
   * palette's Tasks group) search without opening the workspace. Same writer
   * as `questionsByWs`: the debounced recount's `workspace.get` snapshot.
   */
  projectsByWs: Record<string, ProjectEntry[]>;
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
  loadRunEvents(sid: string, ws: string, runId: string): Promise<void>;
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
  const runWsBySid = new Map<string, Map<string, string>>();
  const fetchedRuns = new Set<string>();
  const clientOf = (sid: string): BridgeClient | null => clients.get(sid) ?? null;

  // Debounced save timers keyed by compound workspace key — the key (server +
  // workspace) is captured at schedule time, so a flush after the user
  // switches workspaces or servers still lands in the right place.
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function rebuildRunIndex(sid: string, runsByWs: Record<string, AgentRun[]>): void {
    const prefix = `${sid}/`;
    const index = new Map<string, string>();
    for (const [key, runs] of Object.entries(runsByWs)) {
      if (!key.startsWith(prefix)) continue;
      for (const run of runs) index.set(run.id, key);
    }
    runWsBySid.set(sid, index);
  }

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

  // Questions and project boards live on workspaces, and board writes ride
  // workspace.changed — debounced per workspace, and the single writer of
  // `questionsByWs` + `projectsByWs` (refresh delegates here); a failed read
  // keeps the previous snapshot rather than clearing a genuine signal.
  const questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Permission reads can race an initial fleet refresh. Only the newest read
  // for a workspace may land, or a stale refresh can resurrect a decided row.
  const permissionReadSeq = new Map<string, number>();
  function nextPermissionRead(key: string): number {
    const seq = (permissionReadSeq.get(key) ?? 0) + 1;
    permissionReadSeq.set(key, seq);
    return seq;
  }
  function refreshPermissions(sid: string, ws: string): void {
    const client = clientOf(sid);
    if (!client) return;
    const key = wsKey(sid, ws);
    const seq = nextPermissionRead(key);
    void client
      .request("permissions.pending", { ws })
      .then(({ pending }) => {
        if (permissionReadSeq.get(key) !== seq || clientOf(sid) !== client) return;
        store.setState((s) => ({
          permissionsByWs: { ...s.permissionsByWs, [key]: pending },
        }));
      })
      .catch(() => {
        // workspace closed mid-flight — the next refresh drops it
      });
  }
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
            const questions = needsYouQuestions(info.projects);
            store.setState((s) => {
              const prev = s.questionsByWs[key];
              const annotated = annotateFleetQuestions(
                questions,
                s.runsLoadedByWs[key] ? (s.runsByWs[key] ?? EMPTY_RUNS) : undefined,
                prev,
              );
              return {
                questionsByWs: annotated === prev
                  ? s.questionsByWs
                  : { ...s.questionsByWs, [key]: annotated },
                projectsByWs: { ...s.projectsByWs, [key]: info.projects },
              };
            });
          })
          .catch(() => {
            // workspace closed mid-flight — the next refresh drops it
          });
      }, QUESTION_RECOUNT_DEBOUNCE_MS),
    );
  }

  const store = createStore<FleetState>((set, get) => ({
    runsByWs: {},
    runsLoadedByWs: {},
    workflowsByWs: {},
    eventsByRunKey: {},
    todosByWs: {},
    questionsByWs: {},
    permissionsByWs: {},
    projectsByWs: {},
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
            let index = runWsBySid.get(sid);
            if (!index) runWsBySid.set(sid, (index = new Map()));
            index.set(run.id, key);
            const previousQuestions = s.questionsByWs[key];
            const questions = previousQuestions
              ? annotateFleetQuestions(
                  previousQuestions,
                  s.runsLoadedByWs[key] ? next : undefined,
                  previousQuestions,
                )
              : undefined;
            return {
              runsByWs: { ...s.runsByWs, [key]: next },
              questionsByWs:
                questions && questions !== previousQuestions
                  ? { ...s.questionsByWs, [key]: questions }
                  : s.questionsByWs,
            };
          });
        }),
        client.events.on("workflow.changed", ({ ws, workflow }) => {
          const key = wsKey(sid, ws);
          store.setState((s) => {
            const workflows = s.workflowsByWs[key] ?? EMPTY_WORKFLOWS;
            const idx = workflows.findIndex((item) => item.id === workflow.id);
            const next = idx === -1
              ? [workflow, ...workflows]
              : workflows.map((item, i) => i === idx ? workflow : item);
            return { workflowsByWs: { ...s.workflowsByWs, [key]: next } };
          });
        }),
        client.events.on("agent.event", (event) => {
          const workspaceKey = runWsBySid.get(sid)?.get(event.runId);
          if (!workspaceKey) return;
          const ws = workspaceKey.slice(workspaceKey.indexOf("/") + 1);
          const key = runKey(sid, ws, event.runId);
          // Live tails are retained only after a full fetch, so a present log
          // is always complete-up-to-now rather than an accidentally partial log.
          if (!fetchedRuns.has(key)) return;
          store.setState((s) => {
            const existing = s.eventsByRunKey[key] ?? EMPTY_EVENTS;
            const tail = existing[existing.length - 1];
            if (!tail || tail.seq < event.seq) {
              return { eventsByRunKey: { ...s.eventsByRunKey, [key]: [...existing, event] } };
            }
            if (existing.some((item) => item.seq === event.seq)) return s;
            return { eventsByRunKey: { ...s.eventsByRunKey, [key]: [...existing, event] } };
          });
        }),
        client.events.on("todos.changed", ({ ws, todos }) => {
          const key = wsKey(sid, ws);
          // Skip the echo of our own in-flight save; local state is newer.
          if (store.getState().pendingTodoSaves[key]) return;
          store.setState((s) => ({ todosByWs: { ...s.todosByWs, [key]: todos.items } }));
        }),
        client.events.on("workspace.changed", ({ ws }) => scheduleRecount(sid, ws)),
        client.events.on("permissions.changed", ({ ws }) => refreshPermissions(sid, ws)),
      ];
      return () => {
        for (const dispose of disposers) dispose();
        clients.delete(sid);
        runWsBySid.delete(sid);
        for (const key of permissionReadSeq.keys()) {
          if (key.startsWith(`${sid}/`)) permissionReadSeq.delete(key);
        }
        // The server is gone from the fleet — its slice goes with it. Seen
        // timestamps stay (cheap, and they become live again on re-add).
        const prefix = `${sid}/`;
        const strip = <T,>(map: Record<string, T>): Record<string, T> =>
          Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)));
        set((s) => ({
          runsByWs: strip(s.runsByWs),
          runsLoadedByWs: strip(s.runsLoadedByWs),
          workflowsByWs: strip(s.workflowsByWs),
          eventsByRunKey: strip(s.eventsByRunKey),
          todosByWs: strip(s.todosByWs),
          questionsByWs: strip(s.questionsByWs),
          permissionsByWs: strip(s.permissionsByWs),
          projectsByWs: strip(s.projectsByWs),
        }));
        for (const key of fetchedRuns) if (key.startsWith(prefix)) fetchedRuns.delete(key);
      };
    },

    async refresh(sid, wsIds) {
      const client = clientOf(sid);
      if (!client) return;
      const results = await Promise.all(
        wsIds.map(async (ws) => {
          const key = wsKey(sid, ws);
          const permissionSeq = nextPermissionRead(key);
          const workflowRequest = client.request("workflow.list", { ws }).then(
            (value) => ({ ok: true as const, workflows: value.workflows }),
            () => ({ ok: false as const }),
          );
          const [runs, todos, permissions] = await Promise.all([
            client.request("agent.list", { ws }),
            client.request("todos.get", { ws }),
            client.request("permissions.pending", { ws }),
          ]);
          const workflowResult = await workflowRequest;
          return {
            key,
            runs: runs.runs,
            todos: todos.todos.items,
            permissions: permissions.pending,
            permissionSeq,
            workflowResult,
          };
        }),
      );
      const prefix = `${sid}/`;
      set((s) => {
        // Rebuild only this server's slice; every other server's keys carry over.
        const runsByWs: Record<string, AgentRun[]> = Object.fromEntries(
          Object.entries(s.runsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const runsLoadedByWs: Record<string, true> = Object.fromEntries(
          Object.entries(s.runsLoadedByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const todosByWs: Record<string, TodoItem[]> = Object.fromEntries(
          Object.entries(s.todosByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const workflowsByWs: Record<string, Workflow[]> = Object.fromEntries(
          Object.entries(s.workflowsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const eventsByRunKey: Record<string, RunEvent[]> = Object.fromEntries(
          Object.entries(s.eventsByRunKey).filter(([k]) => !k.startsWith(prefix)),
        );
        for (const eventKey of fetchedRuns) {
          if (eventKey.startsWith(prefix)) fetchedRuns.delete(eventKey);
        }
        const questionsByWs: Record<string, FleetQuestion[]> = Object.fromEntries(
          Object.entries(s.questionsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const permissionsByWs: Record<string, PendingPermission[]> = Object.fromEntries(
          Object.entries(s.permissionsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        const projectsByWs: Record<string, ProjectEntry[]> = Object.fromEntries(
          Object.entries(s.projectsByWs).filter(([k]) => !k.startsWith(prefix)),
        );
        for (const { key, runs, todos, permissions, permissionSeq, workflowResult } of results) {
          runsByWs[key] = runs;
          runsLoadedByWs[key] = true;
          // Carry the recount path's values; closed workspaces drop out. An
          // unread workspace stays ABSENT (not []) — absence is what tells
          // the attention notifier to seed rather than announce.
          const carried = s.questionsByWs[key];
          if (carried !== undefined) {
            questionsByWs[key] = annotateFleetQuestions(carried, runs, carried);
          }
          const boards = s.projectsByWs[key];
          if (boards !== undefined) projectsByWs[key] = boards;
          // An event-driven read that started later wins over this refresh.
          if (permissionReadSeq.get(key) === permissionSeq) {
            permissionsByWs[key] = permissions;
          } else if (s.permissionsByWs[key] !== undefined) {
            permissionsByWs[key] = s.permissionsByWs[key];
          }
          // A pending local edit is newer than what the server just returned.
          todosByWs[key] = s.pendingTodoSaves[key] ? (s.todosByWs[key] ?? todos) : todos;
          if (workflowResult.ok) workflowsByWs[key] = workflowResult.workflows;
          else if (s.workflowsByWs[key] !== undefined) workflowsByWs[key] = s.workflowsByWs[key];
          const runIds = new Set(runs.map((run) => run.id));
          for (const [eventKey, events] of Object.entries(s.eventsByRunKey)) {
            if (!eventKey.startsWith(`${key}/`)) continue;
            const runId = eventKey.slice(key.length + 1);
            if (runIds.has(runId)) {
              eventsByRunKey[eventKey] = events;
              fetchedRuns.add(eventKey);
            }
          }
        }
        return {
          runsByWs,
          runsLoadedByWs,
          todosByWs,
          questionsByWs,
          permissionsByWs,
          projectsByWs,
          workflowsByWs,
          eventsByRunKey,
        };
      });
      rebuildRunIndex(sid, store.getState().runsByWs);
      // Question counts have exactly ONE writer — the recount below — so a
      // slow refresh can never overwrite a fresher event-driven count with
      // data it read before the event.
      for (const ws of wsIds) scheduleRecount(sid, ws);
    },

    async loadRunEvents(sid, ws, runId) {
      const key = runKey(sid, ws, runId);
      if (fetchedRuns.has(key)) return;
      const client = clientOf(sid);
      if (!client) return;
      fetchedRuns.add(key);
      try {
        const { events } = await client.request("agent.events", { ws, runId });
        set((s) => {
          const bySeq = new Map(events.map((event) => [event.seq, event]));
          for (const event of s.eventsByRunKey[key] ?? EMPTY_EVENTS) bySeq.set(event.seq, event);
          return {
            eventsByRunKey: {
              ...s.eventsByRunKey,
              [key]: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
            },
          };
        });
      } catch (error) {
        fetchedRuns.delete(key);
        throw error;
      }
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
