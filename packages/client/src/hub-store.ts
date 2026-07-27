import { createStore, type StoreApi } from "zustand/vanilla";
import { programTag } from "@crystal/core";
import type {
  AgentRun,
  HubDispatchReport,
  HubProject,
  HubQuestion,
  HubRecentProject,
  Program,
  ProgramSpend,
  RunEvent,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * The hub: cross-project programs, the projects they dispatch into, and the
 * program-manager sessions that drive them.
 *
 * Deliberately **unscoped** — a program spans workspaces, so unlike the
 * workflow store this one never filters by `client.scope` and its bridge
 * methods carry no `ws` (they are listed in `UNSCOPED_METHODS`). Spend is held
 * here rather than derived: a program's cost lives in other workspaces' run
 * lists, which this client may not even have loaded.
 */

/** Stable empty references for selectors (zustand v5: no literals in selectors). */
export const EMPTY_PROGRAMS: Program[] = [];
export const EMPTY_HUB_EVENTS: RunEvent[] = [];
export const EMPTY_HUB_PROJECTS: HubProject[] = [];
export const EMPTY_HUB_RECENTS: HubRecentProject[] = [];
export const EMPTY_HUB_QUESTIONS: HubQuestion[] = [];

/** Trailing window that collapses spend-refresh triggers into one round trip. */
const SPEND_REFRESH_DEBOUNCE_MS = 400;

export interface HubState {
  programs: Program[];
  /** Rolled-up spend per program id (deliveries + coordination). */
  spend: Record<string, ProgramSpend>;
  /** Projects the hub can dispatch to. */
  projects: HubProject[];
  recents: HubRecentProject[];
  /**
   * Open questions per program: a project's orchestrator stopped and is
   * waiting on an answer. Live programs only — a finished one waits on nobody.
   */
  questions: Record<string, HubQuestion[]>;
  /** Program-manager runs — hub-scoped, so not in any workspace's run list. */
  runs: AgentRun[];
  eventsByRun: Record<string, RunEvent[]>;
  /** The MCP endpoint an external central agent points at (null until loaded). */
  endpoint: { url: string; mcpConfig: string } | null;
  /**
   * False until the first refresh *settles* — the UI shows a skeleton, not
   * "empty". A failed refresh still flips it (and sets `error`), so a server
   * with the hub disabled shows why instead of loading forever.
   */
  loaded: boolean;
  /** Why the last refresh failed, if it did. */
  error: string | null;

  refresh(): Promise<void>;
  refreshProjects(): Promise<void>;
  createProgram(init: { name: string; goal: string; budgetUsd?: number | null }): Promise<Program>;
  addDelivery(input: {
    programId: string;
    projectRoot: string;
    brief: string;
    dependsOn?: string[];
    templateId?: string | null;
    budgetUsd?: number | null;
  }): Promise<void>;
  removeDelivery(programId: string, deliveryId: string): Promise<void>;
  /** Queue a finished delivery again — the way out of a failed one. */
  retryDelivery(programId: string, deliveryId: string): Promise<void>;
  dispatch(programId: string, deliveryIds?: string[]): Promise<HubDispatchReport>;
  dispatchEpic(input: {
    projectRoot: string;
    name: string;
    goal: string;
    templateId?: string | null;
    budgetUsd?: number | null;
  }): Promise<Program>;
  messageDelivery(programId: string, deliveryId: string, text: string): Promise<{ queued: boolean }>;
  /**
   * Answer a project's question: recorded on its board and handed back to the
   * run that stopped for it. The question leaves `questions` on success.
   */
  answerQuestion(
    programId: string,
    questionId: string,
    answer: string,
  ): Promise<{ ok: true; resumedRunId: string | null } | { ok: false; reason: string }>;
  setPaused(programId: string, paused: boolean, reason?: string | null): Promise<void>;
  setBudget(programId: string, budgetUsd: number | null): Promise<void>;
  setDeliveryBudget(programId: string, deliveryId: string, budgetUsd: number | null): Promise<void>;
  cancel(programId: string): Promise<void>;
  /** Forget a finished program (terminal ones only). */
  remove(programId: string): Promise<void>;
  /**
   * Spawn the program-manager session that owns this program. Pass a
   * `terminal` workspace to run it as a native interactive Claude session on
   * that workspace's PTY (surfaced in the terminal panel) instead of headless.
   */
  startManager(
    programId: string,
    terminal?: { ws: string } | null,
    opts?: { model?: string | null; agentId?: string | null },
  ): Promise<AgentRun>;
  /** Deliver an owner message into the program-manager session. */
  message(programId: string, text: string): Promise<{ queued: boolean }>;
  loadRunEvents(runId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}

export type HubStore = StoreApi<HubState>;

export function createHubStore(client: BridgeClient): HubStore {
  /** Runs whose history has been fetched (see `loadRunEvents`). */
  const fetchedRuns = new Set<string>();

  const upsert = (program: Program) => {
    store.setState((s) => {
      const idx = s.programs.findIndex((p) => p.id === program.id);
      if (idx === -1) return { programs: [program, ...s.programs] };
      const programs = [...s.programs];
      programs[idx] = program;
      return { programs };
    });
  };

  /**
   * Re-read one program's spend — deliveries bill in other workspaces, so it
   * cannot be derived from anything this client holds. Coalesced: a delivery
   * moving fires both `hub.changed` and the underlying `workflow.changed`, and
   * a live run emits `workflow.changed` on every usage tick.
   */
  const spendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshSpend = (programId: string) => {
    if (spendTimers.has(programId)) return;
    spendTimers.set(
      programId,
      setTimeout(async () => {
        spendTimers.delete(programId);
        try {
          const { spend } = await client.request("hub.get", { programId });
          store.setState((s) => ({ spend: { ...s.spend, [programId]: spend } }));
        } catch {
          // A program deleted under us simply keeps its last known spend.
        }
      }, SPEND_REFRESH_DEBOUNCE_MS),
    );
  };

  const store = createStore<HubState>((set, get) => ({
    programs: [],
    spend: {},
    projects: [],
    recents: [],
    questions: {},
    runs: [],
    eventsByRun: {},
    endpoint: null,
    loaded: false,
    error: null,

    async refresh() {
      try {
        const [{ programs, spend }, { runs }, { questions }] = await Promise.all([
          client.request("hub.list", {}),
          client.request("hub.runs", {}),
          client.request("hub.questions", {}),
        ]);
        set({ programs, spend, runs, questions, loaded: true, error: null });
      } catch (err) {
        // A server with the hub disabled (or a dropped connection) must leave
        // the skeleton and say why — retrying is the user's call.
        set({ loaded: true, error: (err as Error).message });
        return;
      }
      // The endpoint never changes while the server lives — fetch it once.
      if (!get().endpoint) {
        const endpoint = await client.request("hub.endpoint", {}).catch(() => null);
        if (endpoint) set({ endpoint });
      }
      await get().refreshProjects().catch(() => {});
    },

    async refreshProjects() {
      const { open, recent } = await client.request("hub.projects", {});
      set({ projects: open, recents: recent });
    },

    async createProgram(init) {
      const { program } = await client.request("hub.createProgram", init);
      upsert(program);
      return program;
    },

    async addDelivery({ programId, ...init }) {
      await client.request("hub.addDelivery", { programId, ...init });
      // The delivery lands on the program record server-side; the changed
      // push carries it back. Refresh explicitly so the UI never waits.
      const { program } = await client.request("hub.get", { programId });
      upsert(program);
    },

    async removeDelivery(programId, deliveryId) {
      await client.request("hub.removeDelivery", { programId, deliveryId });
      const { program } = await client.request("hub.get", { programId });
      upsert(program);
    },

    async retryDelivery(programId, deliveryId) {
      const { program } = await client.request("hub.retryDelivery", { programId, deliveryId });
      upsert(program);
    },

    async dispatch(programId, deliveryIds) {
      const { report } = await client.request("hub.dispatch", { programId, deliveryIds });
      const { program, spend } = await client.request("hub.get", { programId });
      upsert(program);
      set((s) => ({ spend: { ...s.spend, [programId]: spend } }));
      return report;
    },

    async dispatchEpic(input) {
      const { program } = await client.request("hub.dispatchEpic", input);
      upsert(program);
      return program;
    },

    messageDelivery(programId, deliveryId, text) {
      return client.request("hub.messageDelivery", { programId, deliveryId, text });
    },

    async answerQuestion(programId, questionId, answer) {
      // Send where we saw the question (delivery + task): the server then
      // answers that exact board task even when the delivery has settled —
      // the live-deliveries re-derivation alone refuses those as "unknown".
      const seen = (get().questions[programId] ?? []).find(
        (q) => q.questionId === questionId,
      );
      const result = await client.request("hub.answerQuestion", {
        programId,
        questionId,
        answer,
        deliveryId: seen?.deliveryId ?? null,
        taskId: seen?.taskId ?? null,
      });
      // The server re-sweeps and pushes hub.questionsChanged; dropping it here
      // too means the row disappears the moment the answer lands.
      if (result.ok) {
        set((s) => ({
          questions: {
            ...s.questions,
            [programId]: (s.questions[programId] ?? []).filter((q) => q.questionId !== questionId),
          },
        }));
      }
      return result;
    },

    async setPaused(programId, paused, reason) {
      const { program } = await client.request("hub.setPaused", { programId, paused, reason });
      upsert(program);
    },

    async setBudget(programId, budgetUsd) {
      const { program } = await client.request("hub.setBudget", { programId, budgetUsd });
      upsert(program);
    },

    async setDeliveryBudget(programId, deliveryId, budgetUsd) {
      const { program } = await client.request("hub.setDeliveryBudget", {
        programId,
        deliveryId,
        budgetUsd,
      });
      upsert(program);
    },

    async cancel(programId) {
      const { program } = await client.request("hub.cancel", { programId });
      upsert(program);
    },

    async remove(programId) {
      await client.request("hub.remove", { programId });
      // The removed push also lands; dropping it eagerly keeps the list from
      // flashing the program back after the round-trip.
      set((s) => ({ programs: s.programs.filter((p) => p.id !== programId) }));
    },

    async startManager(programId, terminal = null, opts = {}) {
      // The bridge accepts model/agentId here — dropping them silently was
      // why no caller could ever pick the manager's model.
      const { program, run } = await client.request("hub.startManager", {
        programId,
        terminal,
        model: opts.model ?? null,
        agentId: opts.agentId ?? null,
      });
      upsert(program);
      set((s) => ({ runs: [run, ...s.runs] }));
      return run;
    },

    async message(programId, text) {
      const { queued } = await client.request("hub.message", { programId, text });
      return { queued };
    },

    async loadRunEvents(runId) {
      // "Has events" is not "has been fetched": live events land for every hub
      // run whether or not it was ever opened, so the guard has to be its own
      // set — otherwise opening a run mid-stream shows only its tail, forever.
      if (fetchedRuns.has(runId)) return;
      fetchedRuns.add(runId);
      let events: RunEvent[];
      try {
        ({ events } = await client.request("hub.runEvents", { runId }));
      } catch (err) {
        fetchedRuns.delete(runId); // a failed fetch must be retryable
        throw err;
      }
      set((s) => {
        // Union by seq: live events that raced the fetch are neither dropped
        // nor duplicated, whichever side is longer.
        const bySeq = new Map(events.map((e) => [e.seq, e]));
        for (const e of s.eventsByRun[runId] ?? []) bySeq.set(e.seq, e);
        const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        return { eventsByRun: { ...s.eventsByRun, [runId]: merged } };
      });
    },

    async cancelRun(runId) {
      await client.request("hub.cancelRun", { runId });
    },
  }));

  client.events.on("hub.changed", ({ program }) => {
    upsert(program);
    refreshSpend(program.id);
  });

  client.events.on("hub.removed", ({ programId }) => {
    const timer = spendTimers.get(programId);
    if (timer) {
      clearTimeout(timer);
      spendTimers.delete(programId);
    }
    store.setState((s) => {
      const { [programId]: _dropped, ...spend } = s.spend;
      const { [programId]: _asked, ...questions } = s.questions;
      // The manager chain and its transcripts go too — otherwise a session
      // that removes a few programs keeps every event body it ever streamed.
      const tag = programTag(programId);
      const runs = s.runs.filter((r) => !r.tags.includes(tag));
      const eventsByRun = { ...s.eventsByRun };
      for (const r of s.runs) if (r.tags.includes(tag)) delete eventsByRun[r.id];
      return {
        programs: s.programs.filter((p) => p.id !== programId),
        spend,
        questions,
        runs,
        eventsByRun,
      };
    });
  });

  client.events.on("hub.questionsChanged", ({ programId, questions }) => {
    store.setState((s) =>
      // A sweep already in flight when the program was removed would otherwise
      // resurrect it as a phantom entry nothing ever clears.
      s.programs.some((p) => p.id === programId)
        ? { questions: { ...s.questions, [programId]: questions } }
        : s,
    );
  });

  client.events.on("hub.runChanged", ({ run }) => {
    store.setState((s) => {
      const idx = s.runs.findIndex((r) => r.id === run.id);
      if (idx === -1) return { runs: [run, ...s.runs] };
      const runs = [...s.runs];
      runs[idx] = run;
      return { runs };
    });
  });

  client.events.on("hub.event", (event) => {
    store.setState((s) => {
      const existing = s.eventsByRun[event.runId] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return s;
      return { eventsByRun: { ...s.eventsByRun, [event.runId]: [...existing, event] } };
    });
  });

  // A delivery's spend moves as its project's workflow runs — the workflow
  // event is the cheapest signal that a program's rollup went stale.
  client.events.on("workflow.changed", ({ workflow }) => {
    const owner = store
      .getState()
      .programs.find((p) => p.deliveries.some((d) => d.workflowId === workflow.id));
    if (owner) refreshSpend(owner.id);
  });

  return store;
}
