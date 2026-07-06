import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { BRIDGE_PATH, DEFAULT_BRIDGE_PORT, type WorkspaceDescriptor } from "@crystal/core";
import { BridgeClient, type ConnectionState } from "./bridge-client.js";
import { createAgentStore, type AgentState, type AgentStore } from "./agent-store.js";
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
    };
  }, [url]);

  useEffect(() => {
    const { client, workspacesStore, workspaceStore, agentStore } = value;

    const refreshScoped = () => {
      void workspaceStore.getState().refresh();
      void agentStore.getState().refresh();
    };

    // Active-workspace switches re-scope the client and reload scoped stores.
    // Debounced saves are flushed first; they carry their own `ws`, so they
    // still land in the workspace they were made in.
    let prevActive = workspacesStore.getState().activeId;
    const unsubActive = workspacesStore.subscribe((s) => {
      if (s.activeId === prevActive) return;
      prevActive = s.activeId;
      void workspaceStore.getState().flush();
      client.setScope(s.activeId);
      if (s.activeId) refreshScoped();
    });

    const dispose = client.events.on("connection", ({ state }) => {
      if (state === "open") {
        void workspacesStore.getState().refresh();
        // On reconnect the active id may be unchanged; refresh scoped stores
        // explicitly since the subscription above won't fire.
        if (workspacesStore.getState().activeId) refreshScoped();
      }
    });
    client.connect();
    return () => {
      dispose();
      unsubActive();
      void workspaceStore.getState().flush();
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
