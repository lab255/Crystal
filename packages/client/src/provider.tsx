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
  DEFAULT_BRIDGE_PORT,
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

export function defaultBridgeUrl(): string {
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    const host = window.location.hostname || "127.0.0.1";
    return `ws://${host}:${DEFAULT_BRIDGE_PORT}${BRIDGE_PATH}`;
  }
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
