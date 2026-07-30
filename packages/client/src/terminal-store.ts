import { createStore, type StoreApi } from "zustand/vanilla";
import { uid, type TerminalStream } from "@crystal/core";
import { agentEventToChunk } from "./agent-event-chunk.js";
import type { BridgeClient } from "./bridge-client.js";

/** One rendered line/chunk of a terminal transcript. */
export interface TermChunk {
  seq: number;
  stream: TerminalStream;
  text: string;
}

export type TerminalTabKind = "shell" | "agent";

/**
 * A tab in the terminal panel. Shells mirror server terminals (they survive a
 * page reload via `terminal.list` + replay buffers); agent consoles are
 * client-local — each submitted prompt starts an agent run in the tab's
 * workspace, resuming the previous Claude session so the console reads as one
 * conversation. Tabs are cross-workspace *and cross-server* by design: `sid`
 * (bridge connection) and `ws` are explicit everywhere and never rely on the
 * client's active scope. Terminal/run ids are server-local, so every lookup
 * pairs them with the tab's `sid`.
 */
export interface TerminalTab {
  /** Server terminal id for shells; client-generated for agent consoles. */
  id: string;
  /** Bridge connection hosting this terminal (see fleet-client.ts). */
  sid: string;
  ws: string;
  kind: TerminalTabKind;
  status: "running" | "exited";
  /** Tab label override (interactive agent sessions); null = derive from ws/cwd. */
  title: string | null;
  /** Workspace-relative working directory (shells). */
  cwd: string;
  /** Server-side PTY size (shells) — shared across clients, last resizer wins. */
  cols: number | null;
  rows: number | null;
  /** Claude session id to resume for the next prompt (agent consoles). */
  sessionId: string | null;
  /** Run currently executing in this console (agent consoles). */
  activeRunId: string | null;
}

export interface TerminalsState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  chunksByTab: Record<string, TermChunk[]>;
  /**
   * Whether the bottom panel is visible. Lives here (not component state) so
   * dispatching an interactive agent session can reveal its terminal.
   */
  panelOpen: boolean;

  setPanelOpen(open: boolean): void;
  /**
   * Wire a bridge connection's terminal/agent events into this store. Returns
   * a disposer that also drops the connection's tabs (server removed).
   */
  attach(sid: string, client: BridgeClient): () => void;
  /**
   * Reveal the panel and focus a (possibly not-yet-synced) server terminal.
   * `sid` defaults to the active connection — every pre-fleet call site is a
   * per-workspace view, which by the fleet invariant renders the active server.
   */
  focusTerminal(ws: string, terminalId: string, sid?: string): Promise<void>;
  /** Sync one server's shell tabs with its `terminal.list` for the given workspaces. */
  refresh(sid: string, wsIds: string[]): Promise<void>;
  openShell(ws: string, cwd?: string, cols?: number, rows?: number, sid?: string): Promise<string>;
  openAgentConsole(ws: string, sid?: string): string;
  setActive(tabId: string | null): void;
  /** Send a line: shell → PTY input (CR appended); agent → start/resume a run. */
  send(tabId: string, text: string): Promise<void>;
  /** Write raw bytes to a shell's PTY (keystrokes, control chars — no newline added). */
  write(tabId: string, data: string): Promise<void>;
  /** Resize a shell's PTY (shared: broadcasts to every client via terminal.changed). */
  resize(tabId: string, cols: number, rows: number): Promise<void>;
  /** Cancel the agent run executing in a console tab. */
  cancelAgent(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
}

export type TerminalsStore = StoreApi<TerminalsState>;

export function createTerminalsStore(getActiveSid: () => string): TerminalsStore {
  /** Live clients by sid — how a tab's requests find its server. */
  const clients = new Map<string, BridgeClient>();
  function clientFor(sid: string): BridgeClient {
    const client = clients.get(sid);
    if (!client) throw new Error(`No bridge connection: ${sid}`);
    return client;
  }

  // Which console tab each agent run belongs to — runs outlive activeRunId
  // (their tail events still stream after `result` settles the run). Keyed
  // per connection: run ids are server-local.
  const tabByRunId = new Map<string, string>();
  const runKey = (sid: string, runId: string) => `${sid}/${runId}`;
  // Synthetic seq counters for agent consoles.
  const agentSeq = new Map<string, number>();

  function appendChunk(tabId: string, stream: TerminalStream, text: string): void {
    store.setState((s) => {
      const chunks = s.chunksByTab[tabId] ?? [];
      const seq = agentSeq.get(tabId) ?? 0;
      agentSeq.set(tabId, seq + 1);
      return {
        chunksByTab: { ...s.chunksByTab, [tabId]: [...chunks, { seq, stream, text }] },
      };
    });
  }

  function patchTab(tabId: string, patch: Partial<TerminalTab>): void {
    store.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));
  }

  const store = createStore<TerminalsState>((set, get) => ({
    tabs: [],
    activeTabId: null,
    chunksByTab: {},
    panelOpen: false,

    setPanelOpen(open) {
      set({ panelOpen: open });
    },

    attach(sid, client) {
      clients.set(sid, client);
      const disposers = [
        client.events.on("terminal.data", ({ chunk }) => {
          store.setState((s) => {
            // Terminal ids are server-local — match within this connection only.
            const tab = s.tabs.find((t) => t.sid === sid && t.id === chunk.terminalId);
            if (!tab) return s;
            const chunks = s.chunksByTab[tab.id] ?? [];
            const last = chunks[chunks.length - 1];
            if (last && chunk.seq <= last.seq) return s; // replay overlap
            return {
              chunksByTab: {
                ...s.chunksByTab,
                [tab.id]: [...chunks, { seq: chunk.seq, stream: chunk.stream, text: chunk.text }],
              },
            };
          });
        }),
        client.events.on("terminal.changed", ({ ws, terminal }) => {
          store.setState((s) => {
            const idx = s.tabs.findIndex((t) => t.sid === sid && t.id === terminal.id);
            if (idx === -1) {
              // Created elsewhere (another client/tab) — surface it here too.
              if (terminal.status !== "running") return s;
              return {
                tabs: [
                  ...s.tabs,
                  {
                    id: terminal.id,
                    sid,
                    ws,
                    kind: "shell" as const,
                    status: terminal.status,
                    title: terminal.title ?? null,
                    cwd: terminal.cwd,
                    cols: terminal.cols,
                    rows: terminal.rows,
                    sessionId: null,
                    activeRunId: null,
                  },
                ],
              };
            }
            const tabs = [...s.tabs];
            tabs[idx] = {
              ...tabs[idx]!,
              status: terminal.status,
              cols: terminal.cols,
              rows: terminal.rows,
            };
            return { tabs };
          });
        }),
        client.events.on("agent.event", (runEvent) => {
          const tabId = tabByRunId.get(runKey(sid, runEvent.runId));
          if (!tabId) return;
          const chunk = agentEventToChunk(runEvent.event);
          if (chunk) appendChunk(tabId, chunk.stream, chunk.text);
          if (runEvent.event.type === "result") {
            patchTab(tabId, {
              activeRunId: null,
              sessionId:
                runEvent.event.sessionId ??
                store.getState().tabs.find((t) => t.id === tabId)?.sessionId ??
                null,
            });
          } else if (
            runEvent.event.type === "status" &&
            runEvent.event.status !== "running" &&
            runEvent.event.status !== "queued"
          ) {
            // Terminal status without a result (spawn failure, cancel): unblock the console.
            const tab = store.getState().tabs.find((t) => t.id === tabId);
            if (tab?.activeRunId === runEvent.runId) patchTab(tabId, { activeRunId: null });
          }
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
        clients.delete(sid);
        set((s) => {
          const dropped = s.tabs.filter((t) => t.sid === sid);
          const tabs = s.tabs.filter((t) => t.sid !== sid);
          const chunksByTab = { ...s.chunksByTab };
          for (const t of dropped) {
            delete chunksByTab[t.id];
            agentSeq.delete(t.id);
          }
          return {
            tabs,
            chunksByTab,
            activeTabId:
              s.activeTabId && tabs.some((t) => t.id === s.activeTabId)
                ? s.activeTabId
                : (tabs[0]?.id ?? null),
          };
        });
      };
    },

    async focusTerminal(ws, terminalId, sid = getActiveSid()) {
      // The terminal.changed broadcast usually lands before the caller gets
      // here; refresh covers the race (and hydrates the replay buffer).
      const has = () => get().tabs.some((t) => t.sid === sid && t.id === terminalId);
      if (!has()) {
        const wsIds = [
          ...new Set([...get().tabs.filter((t) => t.sid === sid).map((t) => t.ws), ws]),
        ];
        await get().refresh(sid, wsIds);
      }
      set({ panelOpen: true });
      if (has()) set({ activeTabId: terminalId });
    },

    async refresh(sid, wsIds) {
      const client = clients.get(sid);
      if (!client) return;
      const lists = await Promise.all(
        wsIds.map(async (ws) => ({
          ws,
          terminals: (await client.request("terminal.list", { ws })).terminals,
        })),
      );
      const server = lists.flatMap(({ ws, terminals }) =>
        terminals.map((t) => ({ ws, info: t })),
      );
      set((s) => {
        const known = new Set(
          s.tabs.filter((t) => t.sid === sid).map((t) => t.id),
        );
        const added: TerminalTab[] = server
          .filter(({ info }) => !known.has(info.id))
          .map(({ ws, info }) => ({
            id: info.id,
            sid,
            ws,
            kind: "shell" as const,
            status: info.status,
            title: info.title ?? null,
            cwd: info.cwd,
            cols: info.cols,
            rows: info.rows,
            sessionId: null,
            activeRunId: null,
          }));
        const serverIds = new Set(server.map(({ info }) => info.id));
        const infoById = new Map(server.map(({ info }) => [info.id, info]));
        // Shells gone from this server (killed elsewhere, server restart)
        // drop, and so does ANY tab of a workspace no longer open on it —
        // agent consoles included: a closed workspace's console has no
        // server to run in (mirrors the fleet store's "closed workspaces
        // drop out"). Other servers' tabs always survive.
        const kept = s.tabs
          .filter(
            (t) =>
              t.sid !== sid ||
              (wsIds.includes(t.ws) && (t.kind === "agent" || serverIds.has(t.id))),
          )
          .map((t) => {
            if (t.sid !== sid) return t;
            const info = infoById.get(t.id);
            if (!info) return t;
            return info.status !== t.status || info.cols !== t.cols || info.rows !== t.rows
              ? { ...t, status: info.status, cols: info.cols, rows: info.rows }
              : t;
          });
        const tabs = [...kept, ...added];
        return {
          tabs,
          activeTabId:
            s.activeTabId && tabs.some((t) => t.id === s.activeTabId)
              ? s.activeTabId
              : (tabs[0]?.id ?? null),
        };
      });
      // Replay buffers for shells we haven't hydrated yet.
      await Promise.all(
        get()
          .tabs.filter((t) => t.sid === sid && t.kind === "shell" && !get().chunksByTab[t.id])
          .map(async (tab) => {
            try {
              const { chunks } = await client.request("terminal.buffer", {
                ws: tab.ws,
                terminalId: tab.id,
              });
              set((s) => {
                const live = s.chunksByTab[tab.id] ?? [];
                const lastReplayed = chunks[chunks.length - 1]?.seq ?? -1;
                const merged = [...chunks, ...live.filter((c) => c.seq > lastReplayed)];
                return { chunksByTab: { ...s.chunksByTab, [tab.id]: merged } };
              });
            } catch {
              /* terminal vanished between list and buffer */
            }
          }),
      );
    },

    async openShell(ws, cwd, cols, rows, sid = getActiveSid()) {
      const { terminal } = await clientFor(sid).request("terminal.create", {
        ws,
        cwd,
        cols,
        rows,
      });
      set((s) => ({
        tabs: s.tabs.some((t) => t.sid === sid && t.id === terminal.id)
          ? s.tabs
          : [
              ...s.tabs,
              {
                id: terminal.id,
                sid,
                ws,
                kind: "shell",
                status: terminal.status,
                title: terminal.title ?? null,
                cwd: terminal.cwd,
                cols: terminal.cols,
                rows: terminal.rows,
                sessionId: null,
                activeRunId: null,
              },
            ],
        activeTabId: terminal.id,
      }));
      return terminal.id;
    },

    openAgentConsole(ws, sid = getActiveSid()) {
      const id = uid("console");
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
            sid,
            ws,
            kind: "agent",
            status: "running",
            title: null,
            cwd: ".",
            cols: null,
            rows: null,
            sessionId: null,
            activeRunId: null,
          },
        ],
        activeTabId: id,
      }));
      return id;
    },

    setActive(tabId) {
      set({ activeTabId: tabId });
    },

    async send(tabId, text) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) throw new Error(`Unknown terminal tab: ${tabId}`);
      if (tab.kind === "shell") {
        // \r is what a real Enter key sends to a PTY.
        await clientFor(tab.sid).request("terminal.input", {
          ws: tab.ws,
          terminalId: tab.id,
          data: `${text}\r`,
        });
        return;
      }
      if (tab.activeRunId) throw new Error("An agent run is already executing in this console");
      appendChunk(tabId, "input", `${text}\n`);
      const { run } = await clientFor(tab.sid).request("agent.start", {
        ws: tab.ws,
        prompt: text,
        resumeSessionId: tab.sessionId,
      });
      tabByRunId.set(runKey(tab.sid, run.id), tabId);
      patchTab(tabId, { activeRunId: run.id });
    },

    async write(tabId, data) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "shell") throw new Error(`Not a shell tab: ${tabId}`);
      await clientFor(tab.sid).request("terminal.input", {
        ws: tab.ws,
        terminalId: tab.id,
        data,
      });
    },

    async resize(tabId, cols, rows) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "shell") return;
      if (tab.cols === cols && tab.rows === rows) return;
      patchTab(tabId, { cols, rows });
      await clientFor(tab.sid).request("terminal.resize", {
        ws: tab.ws,
        terminalId: tab.id,
        cols,
        rows,
      });
    },

    async cancelAgent(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab?.activeRunId) return;
      await clientFor(tab.sid).request("agent.cancel", { ws: tab.ws, runId: tab.activeRunId });
    },

    async closeTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.kind === "shell") {
        await clientFor(tab.sid)
          .request("terminal.kill", { ws: tab.ws, terminalId: tab.id })
          .catch(() => {/* already gone on the server */});
      } else if (tab.activeRunId) {
        await clientFor(tab.sid)
          .request("agent.cancel", { ws: tab.ws, runId: tab.activeRunId })
          .catch(() => {});
      }
      set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== tabId);
        const { [tabId]: _dropped, ...chunksByTab } = s.chunksByTab;
        return {
          tabs,
          chunksByTab,
          activeTabId: s.activeTabId === tabId ? (tabs[0]?.id ?? null) : s.activeTabId,
        };
      });
      agentSeq.delete(tabId);
    },
  }));

  return store;
}
