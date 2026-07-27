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
 * conversation. Tabs are cross-workspace by design: `ws` is explicit
 * everywhere and never relies on the client's active scope.
 */
export interface TerminalTab {
  /** Server terminal id for shells; client-generated for agent consoles. */
  id: string;
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
  /** Reveal the panel and focus a (possibly not-yet-synced) server terminal. */
  focusTerminal(ws: string, terminalId: string): Promise<void>;
  /** Sync shell tabs with the server's terminals for the given workspaces. */
  refresh(wsIds: string[]): Promise<void>;
  openShell(ws: string, cwd?: string, cols?: number, rows?: number): Promise<string>;
  openAgentConsole(ws: string): string;
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

export function createTerminalsStore(client: BridgeClient): TerminalsStore {
  // Which console tab each agent run belongs to — runs outlive activeRunId
  // (their tail events still stream after `result` settles the run).
  const tabByRunId = new Map<string, string>();
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

    async focusTerminal(ws, terminalId) {
      // The terminal.changed broadcast usually lands before the caller gets
      // here; refresh covers the race (and hydrates the replay buffer).
      if (!get().tabs.some((t) => t.id === terminalId)) {
        await get().refresh([...new Set([...get().tabs.map((t) => t.ws), ws])]);
      }
      set({ panelOpen: true });
      if (get().tabs.some((t) => t.id === terminalId)) set({ activeTabId: terminalId });
    },

    async refresh(wsIds) {
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
        const known = new Set(s.tabs.map((t) => t.id));
        const added: TerminalTab[] = server
          .filter(({ info }) => !known.has(info.id))
          .map(({ ws, info }) => ({
            id: info.id,
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
        // Shells gone from the server (killed elsewhere, server restart) drop;
        // agent consoles are client-local and always survive.
        const kept = s.tabs
          .filter((t) => t.kind === "agent" || (serverIds.has(t.id) && wsIds.includes(t.ws)))
          .map((t) => {
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
          .tabs.filter((t) => t.kind === "shell" && !get().chunksByTab[t.id])
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

    async openShell(ws, cwd, cols, rows) {
      const { terminal } = await client.request("terminal.create", { ws, cwd, cols, rows });
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === terminal.id)
          ? s.tabs
          : [
              ...s.tabs,
              {
                id: terminal.id,
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

    openAgentConsole(ws) {
      const id = uid("console");
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
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
        await client.request("terminal.input", {
          ws: tab.ws,
          terminalId: tab.id,
          data: `${text}\r`,
        });
        return;
      }
      if (tab.activeRunId) throw new Error("An agent run is already executing in this console");
      appendChunk(tabId, "input", `${text}\n`);
      const { run } = await client.request("agent.start", {
        ws: tab.ws,
        prompt: text,
        resumeSessionId: tab.sessionId,
      });
      tabByRunId.set(run.id, tabId);
      patchTab(tabId, { activeRunId: run.id });
    },

    async write(tabId, data) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "shell") throw new Error(`Not a shell tab: ${tabId}`);
      await client.request("terminal.input", { ws: tab.ws, terminalId: tab.id, data });
    },

    async resize(tabId, cols, rows) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "shell") return;
      if (tab.cols === cols && tab.rows === rows) return;
      patchTab(tabId, { cols, rows });
      await client.request("terminal.resize", { ws: tab.ws, terminalId: tab.id, cols, rows });
    },

    async cancelAgent(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab?.activeRunId) return;
      await client.request("agent.cancel", { ws: tab.ws, runId: tab.activeRunId });
    },

    async closeTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.kind === "shell") {
        await client
          .request("terminal.kill", { ws: tab.ws, terminalId: tab.id })
          .catch(() => {/* already gone on the server */});
      } else if (tab.activeRunId) {
        await client
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

  client.events.on("terminal.data", ({ chunk }) => {
    store.setState((s) => {
      const existing = s.chunksByTab[chunk.terminalId];
      // Ignore terminals we don't track (other clients' workspaces still open here get tabs via refresh/changed).
      if (!s.tabs.some((t) => t.id === chunk.terminalId)) return s;
      const chunks = existing ?? [];
      const last = chunks[chunks.length - 1];
      if (last && chunk.seq <= last.seq) return s; // replay overlap
      return {
        chunksByTab: {
          ...s.chunksByTab,
          [chunk.terminalId]: [...chunks, { seq: chunk.seq, stream: chunk.stream, text: chunk.text }],
        },
      };
    });
  });

  client.events.on("terminal.changed", ({ ws, terminal }) => {
    store.setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === terminal.id);
      if (idx === -1) {
        // Created elsewhere (another client/tab) — surface it here too.
        if (terminal.status !== "running") return s;
        return {
          tabs: [
            ...s.tabs,
            {
              id: terminal.id,
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
  });

  client.events.on("agent.event", (runEvent) => {
    const tabId = tabByRunId.get(runEvent.runId);
    if (!tabId) return;
    const chunk = agentEventToChunk(runEvent.event);
    if (chunk) appendChunk(tabId, chunk.stream, chunk.text);
    if (runEvent.event.type === "result") {
      patchTab(tabId, {
        activeRunId: null,
        sessionId: runEvent.event.sessionId ?? store.getState().tabs.find((t) => t.id === tabId)?.sessionId ?? null,
      });
    } else if (runEvent.event.type === "status" && runEvent.event.status !== "running" && runEvent.event.status !== "queued") {
      // Terminal status without a result (spawn failure, cancel): unblock the console.
      const tab = store.getState().tabs.find((t) => t.id === tabId);
      if (tab?.activeRunId === runEvent.runId) patchTab(tabId, { activeRunId: null });
    }
  });

  return store;
}
