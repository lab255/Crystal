import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { BRIDGE_PATH, DEFAULT_BRIDGE_PORT } from "@crystal/core";
import { BridgeClient, type ConnectionState } from "./bridge-client.js";
import { createAgentStore, type AgentState, type AgentStore } from "./agent-store.js";
import {
  createWorkspaceStore,
  type WorkspaceState,
  type WorkspaceStore,
} from "./workspace-store.js";

export interface CrystalContextValue {
  client: BridgeClient;
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
      workspaceStore: createWorkspaceStore(client),
      agentStore: createAgentStore(client),
    };
  }, [url]);

  useEffect(() => {
    const { client, workspaceStore, agentStore } = value;
    const dispose = client.events.on("connection", ({ state }) => {
      if (state === "open") {
        void workspaceStore.getState().refresh();
        void agentStore.getState().refresh();
      }
    });
    client.connect();
    return () => {
      dispose();
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

export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  const { workspaceStore } = useCrystal();
  return useStore(workspaceStore, selector);
}

export function useAgents<T>(selector: (s: AgentState) => T): T {
  const { agentStore } = useCrystal();
  return useStore(agentStore, selector);
}
