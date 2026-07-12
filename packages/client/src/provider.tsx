import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  BRIDGE_PATH,
  BRIDGE_TOKEN_COOKIE,
  BRIDGE_TOKEN_PARAM,
  DEFAULT_BRIDGE_PORT,
  createTaskQuestion,
  nowIso,
  type DeepLink,
  type WorkspaceDescriptor,
} from "@crystal/core";
import { BridgeClient, type ConnectionState } from "./bridge-client.js";
import { createAgentStore, type AgentState, type AgentStore } from "./agent-store.js";
import { createFleetStore, type FleetState, type FleetStore } from "./fleet-store.js";
import {
  createHighlightStore,
  type HighlightState,
  type HighlightStore,
} from "./highlight-store.js";
import { createNavStore, type NavPatch, type NavStore } from "./nav-store.js";
import {
  createTerminalsStore,
  type TerminalsState,
  type TerminalsStore,
} from "./terminal-store.js";
import {
  createWorkspaceStore,
  type WorkspaceState,
  type WorkspaceStore,
} from "./workspace-store.js";
import {
  createWorkspacesStore,
  type WorkspacesState,
  type WorkspacesStore,
} from "./workspaces-store.js";

export interface CrystalContextValue {
  client: BridgeClient;
  workspacesStore: WorkspacesStore;
  workspaceStore: WorkspaceStore;
  agentStore: AgentStore;
  fleetStore: FleetStore;
  terminalsStore: TerminalsStore;
  navStore: NavStore;
  highlightStore: HighlightStore;
}

const CrystalContext = createContext<CrystalContextValue | null>(null);

/**
 * Bearer token for a remote bridge. Sourced (in order) from `?token=` on the
 * URL — which is then persisted and stripped from the address bar — an
 * injected `window.__CRYSTAL_CONFIG__`, or a prior localStorage save. Usually
 * null in the same-origin flow: the server promotes `?token=` to an HttpOnly
 * cookie before the SPA loads, and that cookie authenticates the WS upgrade.
 */
function resolveBridgeToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get(BRIDGE_TOKEN_PARAM);
    if (q) {
      try {
        localStorage.setItem(BRIDGE_TOKEN_COOKIE, q);
      } catch {
        /* storage may be unavailable (private mode) */
      }
      url.searchParams.delete(BRIDGE_TOKEN_PARAM);
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return q;
    }
  } catch {
    /* malformed URL — fall through */
  }
  const injected = (window as unknown as { __CRYSTAL_CONFIG__?: { token?: string } })
    .__CRYSTAL_CONFIG__?.token;
  if (injected) return injected;
  try {
    return localStorage.getItem(BRIDGE_TOKEN_COOKIE);
  } catch {
    return null;
  }
}

/**
 * True inside the Tauri desktop WebView. Tauri v2 always injects
 * `__TAURI_INTERNALS__` (and `isTauri`) into the page — independent of the
 * `withGlobalTauri` option that only controls `window.__TAURI__`.
 */
function inTauriWebview(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "isTauri" in w || "__TAURI__" in w;
}

export function defaultBridgeUrl(): string {
  if (
    typeof window !== "undefined" &&
    window.location.protocol.startsWith("http") &&
    !inTauriWebview()
  ) {
    // Served same-origin (web console / remote deploy): derive scheme and host
    // (incl. port) from the page so it works on 443, on 4517, or behind any
    // reverse proxy — and upgrade to wss:// whenever the page is https. In the
    // Vite dev server this yields ws://localhost:5173/crystal, which the dev
    // proxy (apps/web/vite.config.ts) forwards to the bridge on :4517.
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = resolveBridgeToken();
    const query = token ? `?${BRIDGE_TOKEN_PARAM}=${encodeURIComponent(token)}` : "";
    return `${scheme}//${window.location.host}${BRIDGE_PATH}${query}`;
  }
  // Tauri desktop: the WebView serves the app from tauri.localhost (Windows
  // WebView2) or the tauri:// asset protocol (macOS/Linux) — neither is the
  // bridge origin. The sidecar bridge is always local on loopback:4517.
  return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}${BRIDGE_PATH}`;
}

export function CrystalProvider({
  url,
  children,
}: {
  /** Bridge WebSocket URL; defaults to the local bridge server. */
  url?: string;
  children: ReactNode;
}) {
  const value = useMemo<CrystalContextValue>(() => {
    const client = new BridgeClient(url ?? defaultBridgeUrl());
    return {
      client,
      workspacesStore: createWorkspacesStore(client),
      workspaceStore: createWorkspaceStore(client),
      agentStore: createAgentStore(client),
      fleetStore: createFleetStore(client),
      terminalsStore: createTerminalsStore(client),
      navStore: createNavStore(),
      highlightStore: createHighlightStore(),
    };
  }, [url]);

  useEffect(() => {
    const { client, workspacesStore, workspaceStore, agentStore, fleetStore, terminalsStore } =
      value;

    const refreshScoped = () => {
      void workspaceStore.getState().refresh();
      void agentStore.getState().refresh();
    };

    const refreshFleet = () => {
      const ids = workspacesStore.getState().workspaces.map((w) => w.id);
      if (ids.length === 0) return;
      void fleetStore.getState().refresh(ids);
      void terminalsStore.getState().refresh(ids);
    };

    // Active-workspace switches re-scope the client and reload scoped stores.
    // Debounced saves are flushed first; they carry their own `ws`, so they
    // still land in the workspace they were made in.
    let prevActive = workspacesStore.getState().activeId;
    let prevIds = workspacesStore.getState().workspaces.map((w) => w.id).join(",");
    const unsubActive = workspacesStore.subscribe((s) => {
      const ids = s.workspaces.map((w) => w.id).join(",");
      if (ids !== prevIds) {
        prevIds = ids;
        refreshFleet();
      }
      if (s.activeId === prevActive) return;
      prevActive = s.activeId;
      void workspaceStore.getState().flush();
      client.setScope(s.activeId);
      if (s.activeId) {
        refreshScoped();
        // Focusing a workspace acknowledges its finished agent runs.
        fleetStore.getState().markSeen(s.activeId);
      }
    });

    // Run results landing in the workspace you're already looking at are seen.
    const disposeRunChanged = client.events.on("agent.runChanged", ({ ws }) => {
      if (ws === workspacesStore.getState().activeId) fleetStore.getState().markSeen(ws);
    });

    // An agent asked for user input mid-run: file it as an async question on
    // the run's task, where the human owner answers it from the board.
    const disposeQuestion = client.events.on("agent.event", ({ runId, event }) => {
      if (event.type !== "question") return;
      const run = agentStore.getState().runs.find((r) => r.id === runId);
      if (!run?.taskId) return;
      const info = workspaceStore.getState().info;
      const entry = info?.projects.find((p) =>
        p.project.tasks.some((t) => t.id === run.taskId),
      );
      const task = entry?.project.tasks.find((t) => t.id === run.taskId);
      if (!entry || !task) return;
      if (task.questions.some((q) => q.runId === runId && q.text === event.text)) return;
      workspaceStore.getState().updateProject(entry.path, {
        ...entry.project,
        tasks: entry.project.tasks.map((t) =>
          t.id === task.id
            ? {
                ...t,
                questions: [...t.questions, createTaskQuestion(event.text, runId)],
                updatedAt: nowIso(),
              }
            : t,
        ),
      });
    });

    const dispose = client.events.on("connection", ({ state }) => {
      if (state === "open") {
        void workspacesStore.getState().refresh();
        // On reconnect the active id may be unchanged; refresh scoped stores
        // explicitly since the subscription above won't fire.
        if (workspacesStore.getState().activeId) refreshScoped();
        refreshFleet();
      }
    });
    client.connect();
    return () => {
      dispose();
      disposeRunChanged();
      disposeQuestion();
      unsubActive();
      void workspaceStore.getState().flush();
      void fleetStore.getState().flush();
      client.close();
    };
  }, [value]);

  return <CrystalContext.Provider value={value}>{children}</CrystalContext.Provider>;
}

export function useCrystal(): CrystalContextValue {
  const ctx = useContext(CrystalContext);
  if (!ctx) throw new Error("useCrystal must be used inside <CrystalProvider>");
  return ctx;
}

export function useConnectionState(): ConnectionState {
  const { client } = useCrystal();
  return useSyncExternalStore(
    (onChange) => client.events.on("connection", onChange),
    () => client.state,
    () => client.state,
  );
}

export function useWorkspaces<T>(selector: (s: WorkspacesState) => T): T {
  const { workspacesStore } = useCrystal();
  return useStore(workspacesStore, selector);
}

/** Descriptor of the workspace this UI is focused on (null while loading). */
export function useActiveWorkspace(): WorkspaceDescriptor | null {
  const { workspacesStore } = useCrystal();
  return useStore(
    workspacesStore,
    (s) => s.workspaces.find((w) => w.id === s.activeId) ?? null,
  );
}

export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  const { workspaceStore } = useCrystal();
  return useStore(workspaceStore, selector);
}

export function useAgents<T>(selector: (s: AgentState) => T): T {
  const { agentStore } = useCrystal();
  return useStore(agentStore, selector);
}

/** Cross-workspace runs, todos and traffic lights (see `FleetState`). */
export function useFleet<T>(selector: (s: FleetState) => T): T {
  const { fleetStore } = useCrystal();
  return useStore(fleetStore, selector);
}

/** Terminal panel tabs and transcripts across all workspaces. */
export function useTerminals<T>(selector: (s: TerminalsState) => T): T {
  const { terminalsStore } = useCrystal();
  return useStore(terminalsStore, selector);
}

/**
 * Select from the deep-linkable navigation state. Selectors should return
 * primitives (or references stored in the link itself) — zustand v5 rules.
 */
export function useNav<T>(selector: (link: DeepLink) => T): T {
  const { navStore } = useCrystal();
  return useStore(navStore, (s) => selector(s.link));
}

/** Stable updater for the navigation state (see `NavPatch` for semantics). */
export function useNavUpdate(): (patch: NavPatch) => void {
  const { navStore } = useCrystal();
  return navStore.getState().update;
}

/**
 * Select from the ephemeral cross-view hover highlight. Subscribing
 * components light up elements whose identity matches (see `matchHighlight`).
 */
export function useHighlight<T>(selector: (s: HighlightState) => T): T {
  const { highlightStore } = useCrystal();
  return useStore(highlightStore, selector);
}

/** Stable publisher for the hover highlight (see `HighlightState.setHover`). */
export function useHighlightUpdate(): HighlightState["setHover"] {
  const { highlightStore } = useCrystal();
  return highlightStore.getState().setHover;
}
