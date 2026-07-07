import { createStore, type StoreApi } from "zustand/vanilla";
import {
  uid,
  type AgentEvent,
  type TerminalStream,
} from "@crystal/core";
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
  /** Workspace-relative working directory (shells). */
  cwd: string;
  /** Claude session id to resume for the next prompt (agent consoles). */
  sessionId: string | null;
  /** Run currently executing in this console (agent consoles). */
  activeRunId: string | null;
}

export interface TerminalsState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  chunksByTab: Record<string, TermChunk[]>;

  /** Sync shell tabs with the server's terminals for the given workspaces. */
  refresh(wsIds: string[]): Promise<void>;
  openShell(ws: string, cwd?: string): Promise<string>;
  openAgentConsole(ws: string): string;
  setActive(tabId: string | null): void;
  /** Send a line: shell → stdin (newline appended); agent → start/resume a run. */
  send(tabId: string, text: string): Promise<void>;
  /** Cancel the agent run executing in a console tab. */
  cancelAgent(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
}

export type TerminalsStore = StoreApi<TerminalsState>;

const AGENT_PREVIEW_KEYS = ["command", "file_path", "path", "pattern", "url", "prompt"] as const;

/** One-line transcript rendering of an agent event (null = don't show). */
export function agentEventToChunk(event: AgentEvent): { stream: TerminalStream; text: string } | null {
  switch (event.type) {
    case "text":
      return { stream: "stdout", text: event.text.endsWith("\n") ? event.text : `${event.text}\n` };
    case "tool_use": {
      let detail = "";
      if (event.input && typeof event.input === "object") {
        for (const key of AGENT_PREVIEW_KEYS) {
          const value = (event.input as Record<string, unknown>)[key];
          if (typeof value === "string" && value) {
            detail = value.length > 120 ? `${value.slice(0, 120)}…` : value;
            break;
          }
        }
      }
      return { stream: "system", text: `▸ ${event.name}${detail ? ` ${detail}` : ""}\n` };
    }
    case "tool_result":
      return event.isError ? { stream: "stderr", text: `${event.content}\n` } : null;
    case "stderr":
      return { stream: "stderr", text: `${event.text}\n` };
    case "result": {
      if (!event.ok) return { stream: "stderr", text: `✖ ${event.resultText || "run failed"}\n` };
      const cost = event.costUsd != null ? ` · $${event.costUsd.toFixed(2)}` : "";
      const turns = event.turns != null ? ` · ${event.turns} turns` : "";
      return { stream: "system", text: `✔ done${cost}${turns}\n` };
    }
    case "status":
      return event.message ? { stream: "system", text: `${event.message}\n` } : null;
    case "init":
    case "thinking":
    case "unknown":
      return null;
  }
}

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
            cwd: info.cwd,
            sessionId: null,
            activeRunId: null,
          }));
        const serverIds = new Set(server.map(({ info }) => info.id));
        const statusById = new Map(server.map(({ info }) => [info.id, info.status]));
        // Shells gone from the server (killed elsewhere, server restart) drop;
        // agent consoles are client-local and always survive.
        const kept = s.tabs
          .filter((t) => t.kind === "agent" || (serverIds.has(t.id) && wsIds.includes(t.ws)))
          .map((t) => {
            const status = statusById.get(t.id);
            return status && status !== t.status ? { ...t, status } : t;
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

    async openShell(ws, cwd) {
      const { terminal } = await client.request("terminal.create", { ws, cwd });
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
                cwd: terminal.cwd,
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
          { id, ws, kind: "agent", status: "running", cwd: ".", sessionId: null, activeRunId: null },
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
        await client.request("terminal.input", {
          ws: tab.ws,
          terminalId: tab.id,
          data: `${text}\n`,
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
              cwd: terminal.cwd,
              sessionId: null,
              activeRunId: null,
            },
          ],
        };
      }
      const tabs = [...s.tabs];
      tabs[idx] = { ...tabs[idx]!, status: terminal.status };
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
