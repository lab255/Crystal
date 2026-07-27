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
  DEFAULT_SERVER_SID,
  type DeepLink,
  type WorkspaceDescriptor,
} from "@crystal/core";
import {
  BridgeClient,
  type BridgeTransportFactory,
  type ConnectionState,
} from "./bridge-client.js";
import { tauriBridgeTransport } from "./tauri-transport.js";
import { checkForDesktopUpdate } from "./desktop-update.js";
import {
  FleetClient,
  wsKey,
  type FleetClientState,
  type ServerConnection,
} from "./fleet-client.js";
import { createAgentStore, type AgentState, type AgentStore } from "./agent-store.js";
import { createFleetStore, type FleetState, type FleetStore } from "./fleet-store.js";
import {
  createHighlightStore,
  type HighlightState,
  type HighlightStore,
} from "./highlight-store.js";
import { createHubStore, type HubState, type HubStore } from "./hub-store.js";
import { createLensStore, type LensState, type LensStore } from "./lens-store.js";
import { createNavStore, type NavPatch, type NavStore } from "./nav-store.js";
import {
  createTerminalsStore,
  type TerminalsState,
  type TerminalsStore,
} from "./terminal-store.js";
import {
  createWorkflowStore,
  type WorkflowState,
  type WorkflowStore,
} from "./workflow-store.js";
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

/**
 * Everything a Crystal view can reach. The **fleet invariant** (docs/
 * agent-ops.md Track C): per-workspace modes stay single-server. The `client`
 * and per-workspace stores here are the *active connection's* store bundle —
 * one full set of stores is constructed per connected bridge server, and
 * switching to another server's workspace swaps which bundle this context
 * resolves to. Every pre-fleet hook keeps working unchanged because a mode
 * tree only ever sees its own (server, workspace) pair.
 *
 * Cross-server surfaces use the shared pieces instead: `fleetStore` and
 * `terminalsStore` are single instances fed by every connection (compound
 * `"<sid>/<wsId>"` keys / `sid`-tagged tabs), `fleet` exposes the connection
 * roster, and `navStore`/`highlightStore` are global by nature.
 */
export interface CrystalContextValue {
  /** The active connection's bridge client. */
  client: BridgeClient;
  /** The fleet layer: every connection, discovery, add/remove. */
  fleet: FleetClient;
  /** Stable connection id of the active server (`"default"` = bootstrapped). */
  activeSid: string;
  /** Focus a workspace on any connected server (switches the bundle too). */
  selectWorkspace: (sid: string, wsId: string) => void;
  workspacesStore: WorkspacesStore;
  workspaceStore: WorkspaceStore;
  agentStore: AgentStore;
  /** Shared across connections — compound-keyed (see fleet-store.ts). */
  fleetStore: FleetStore;
  /** Shared across connections — tabs carry their `sid`. */
  terminalsStore: TerminalsStore;
  workflowStore: WorkflowStore;
  /**
   * The ACTIVE server's hub bundle (fleet v1): `~/.crystal/hub/programs` is
   * machine-shared, so per-server rendering is correct for local servers and
   * remote hubs simply follow the server you're focused on. A true cross-fleet
   * hub belongs to the account layer (see docs/agent-ops.md C3).
   */
  hubStore: HubStore;
  navStore: NavStore;
  highlightStore: HighlightStore;
  lensStore: LensStore;
}

const CrystalContext = createContext<CrystalContextValue | null>(null);

/**
 * Bearer token for a remote bridge. Sourced (in order) from `?token=` on the
 * URL — which is then persisted and stripped from the address bar — an
 * injected `window.__CRYSTAL_CONFIG__`, or a prior localStorage save. Usually
 * null in the same-origin flow: the server promotes `?token=` to an HttpOnly
 * cookie before the SPA loads, and that cookie authenticates the WS upgrade.
 * This legacy single slot stays the DEFAULT connection's fallback; added
 * connections use the per-endpoint token map (see fleet-client.ts).
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
  return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}${BRIDGE_PATH}`;
}

/**
 * Where the bridge client should connect by default. In the Tauri desktop the
 * WebView serves the app from tauri.localhost / tauri:// — not the bridge
 * origin — and the sidecar listens on a local IPC pipe rather than TCP, so
 * the connection goes through the shell's pipe relay (falling back to the dev
 * WebSocket only when the shell owns no pipe). Everywhere else: WebSocket URL.
 */
export function defaultBridgeTarget(): string | BridgeTransportFactory {
  if (inTauriWebview()) return tauriBridgeTransport(defaultBridgeUrl());
  return defaultBridgeUrl();
}

/** One connected server's store set — resolved via the active (server, ws). */
interface ServerBundle {
  sid: string;
  client: BridgeClient;
  workspacesStore: WorkspacesStore;
  workspaceStore: WorkspaceStore;
  agentStore: AgentStore;
  workflowStore: WorkflowStore;
  hubStore: HubStore;
  lensStore: LensStore;
  dispose: () => void;
}

/**
 * The imperative heart of the provider: the FleetClient, one store bundle per
 * connection (built as connections appear), the shared cross-server stores,
 * and all the wiring between them. Constructed during render (no network);
 * `connect()`/`disconnect()` run from the mount effect.
 */
interface FleetRuntime {
  fleet: FleetClient;
  fleetStore: FleetStore;
  terminalsStore: TerminalsStore;
  navStore: NavStore;
  highlightStore: HighlightStore;
  selectWorkspace: (sid: string, wsId: string) => void;
  getValue: () => CrystalContextValue;
  subscribe: (onChange: () => void) => () => void;
  connect: () => void;
  disconnect: () => void;
}

function createFleetRuntime(defaultTarget: string | BridgeTransportFactory): FleetRuntime {
  const fleet = new FleetClient({ defaultTarget });
  const navStore = createNavStore();
  const highlightStore = createHighlightStore();
  const fleetStore = createFleetStore();
  const terminalsStore = createTerminalsStore(() => fleet.activeSid);
  const bundles = new Map<string, ServerBundle>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };

  const ensureLens = () => {
    const bundle = bundles.get(fleet.activeSid);
    if (!bundle) return;
    void bundle.lensStore
      .getState()
      .ensure(bundle.workspacesStore.getState().activeId, navStore.getState().link.lens);
  };

  const selectWorkspace = (sid: string, wsId: string): void => {
    const bundle = bundles.get(sid);
    if (!bundle) return;
    bundle.workspacesStore.getState().setActive(wsId);
    fleet.setActive(sid);
  };

  function wireBundle(sid: string): void {
    const client = fleet.clientOf(sid);
    if (!client || bundles.has(sid)) return;
    const workspacesStore = createWorkspacesStore(client);
    const workspaceStore = createWorkspaceStore(client);
    const agentStore = createAgentStore(client);
    const workflowStore = createWorkflowStore(client);
    const hubStore = createHubStore(client);
    const lensStore = createLensStore(client);

    const disposers: (() => void)[] = [
      fleetStore.getState().attach(sid, client),
      terminalsStore.getState().attach(sid, client),
    ];

    const refreshScoped = () => {
      void workspaceStore.getState().refresh();
      void agentStore.getState().refresh();
      void workflowStore.getState().refresh();
    };

    const refreshFleetSlice = () => {
      const ids = workspacesStore.getState().workspaces.map((w) => w.id);
      if (ids.length === 0) return;
      void fleetStore.getState().refresh(sid, ids);
      void terminalsStore.getState().refresh(sid, ids);
      // The hub's project list follows the open set; its programs do not, but
      // one refresh covers both and only fires on workspace-set changes.
      void hubStore.getState().refresh();
    };

    // Active-workspace switches re-scope this connection's client and reload
    // its scoped stores. Debounced saves are flushed first; they carry their
    // own `ws`, so they still land in the workspace they were made in.
    let prevActive = workspacesStore.getState().activeId;
    let prevIds = workspacesStore.getState().workspaces.map((w) => w.id).join(",");
    disposers.push(
      workspacesStore.subscribe((s) => {
        // Mirror into the fleet roster so cross-server surfaces (tabs,
        // overview, terminal + menu) see every server's workspaces without
        // subscribing to N stores.
        fleet.patch(sid, { workspaces: s.workspaces, activeWs: s.activeId });
        const ids = s.workspaces.map((w) => w.id).join(",");
        if (ids !== prevIds) {
          prevIds = ids;
          refreshFleetSlice();
        }
        if (s.activeId === prevActive) return;
        prevActive = s.activeId;
        void workspaceStore.getState().flush();
        client.setScope(s.activeId);
        if (s.activeId) {
          refreshScoped();
          if (fleet.activeSid === sid) {
            // Focusing a workspace acknowledges its finished agent runs.
            fleetStore.getState().markSeen(wsKey(sid, s.activeId));
            // The lens membership is workspace-scoped — re-resolve.
            ensureLens();
          }
        }
      }),
    );

    // Run results landing in the workspace you're already looking at are seen.
    disposers.push(
      client.events.on("agent.runChanged", ({ ws }) => {
        if (fleet.activeSid === sid && ws === workspacesStore.getState().activeId) {
          fleetStore.getState().markSeen(wsKey(sid, ws));
        }
      }),
    );

    // Re-resolve diff lenses when the code map re-analyzes (files changed).
    disposers.push(
      client.events.on("codemap.changed", ({ ws }) => {
        const { spec } = lensStore.getState();
        if (
          fleet.activeSid === sid &&
          spec?.kind === "diff" &&
          ws === workspacesStore.getState().activeId
        ) {
          void lensStore.getState().refresh();
        }
      }),
    );

    // Questions raised by agent runs are filed onto their board task by the
    // server (which sees them even when no browser is open); the board picks
    // them up through the workspace.changed refetch like any other write.

    disposers.push(
      client.events.on("connection", ({ state }) => {
        if (state === "open") {
          void workspacesStore.getState().refresh();
          // On reconnect the active id may be unchanged; refresh scoped stores
          // explicitly since the subscription above won't fire.
          if (workspacesStore.getState().activeId) refreshScoped();
          refreshFleetSlice();
        }
      }),
    );

    bundles.set(sid, {
      sid,
      client,
      workspacesStore,
      workspaceStore,
      agentStore,
      workflowStore,
      hubStore,
      lensStore,
      dispose: () => {
        for (const d of disposers) d();
        void workspaceStore.getState().flush();
      },
    });
  }

  // Bundles follow connections; the default one exists from start() below.
  fleet.events.on("added", ({ sid }) => wireBundle(sid));
  fleet.events.on("removed", ({ sid }) => {
    bundles.get(sid)?.dispose();
    bundles.delete(sid);
    notify();
  });

  // Switching the active connection swaps the bundle the context resolves to.
  let prevSid = fleet.activeSid;
  fleet.store.subscribe((s) => {
    if (s.activeSid === prevSid) return;
    const prev = bundles.get(prevSid);
    prevSid = s.activeSid;
    void prev?.workspaceStore.getState().flush();
    const next = bundles.get(s.activeSid);
    const activeId = next?.workspacesStore.getState().activeId;
    // Focusing another server's workspace acknowledges its finished runs.
    if (activeId) fleetStore.getState().markSeen(wsKey(s.activeSid, activeId));
    ensureLens();
    notify();
  });

  // Global lens: resolve whenever the lens param or active workspace moves.
  navStore.subscribe((s, prev) => {
    if (s.link.lens !== prev.link.lens || s.link.ws !== prev.link.ws) ensureLens();
  });

  fleet.start(); // creates the default + roster connections (no network yet)
  ensureLens();

  let cached: CrystalContextValue | null = null;
  const getValue = (): CrystalContextValue => {
    const sid = fleet.activeSid;
    const bundle = bundles.get(sid) ?? bundles.get(DEFAULT_SERVER_SID);
    if (!bundle) throw new Error("FleetRuntime has no default bundle");
    if (!cached || cached.activeSid !== bundle.sid) {
      cached = {
        client: bundle.client,
        fleet,
        activeSid: bundle.sid,
        selectWorkspace,
        workspacesStore: bundle.workspacesStore,
        workspaceStore: bundle.workspaceStore,
        agentStore: bundle.agentStore,
        fleetStore,
        terminalsStore,
        workflowStore: bundle.workflowStore,
        hubStore: bundle.hubStore,
        navStore,
        highlightStore,
        lensStore: bundle.lensStore,
      };
    }
    return cached;
  };

  return {
    fleet,
    fleetStore,
    terminalsStore,
    navStore,
    highlightStore,
    selectWorkspace,
    getValue,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    connect: () => fleet.connectAll(),
    disconnect: () => {
      void fleetStore.getState().flush();
      for (const bundle of bundles.values()) void bundle.workspaceStore.getState().flush();
      fleet.disconnectAll();
    },
  };
}

export function CrystalProvider({
  url,
  children,
}: {
  /** Bridge WebSocket URL; defaults to the local bridge server. */
  url?: string;
  children: ReactNode;
}) {
  const runtime = useMemo(() => createFleetRuntime(url ?? defaultBridgeTarget()), [url]);

  useEffect(() => {
    runtime.connect();
    // Desktop only, best-effort: pull a newer signed build if one's out.
    void checkForDesktopUpdate();
    return () => {
      runtime.disconnect();
    };
  }, [runtime]);

  const value = useSyncExternalStore(runtime.subscribe, runtime.getValue, runtime.getValue);

  return <CrystalContext.Provider value={value}>{children}</CrystalContext.Provider>;
}

export function useCrystal(): CrystalContextValue {
  const ctx = useContext(CrystalContext);
  if (!ctx) throw new Error("useCrystal must be used inside <CrystalProvider>");
  return ctx;
}

/** Connection state of the ACTIVE server (the footer aggregates all of them). */
export function useConnectionState(): ConnectionState {
  const { client } = useCrystal();
  return useSyncExternalStore(
    (onChange) => client.events.on("connection", onChange),
    () => client.state,
    () => client.state,
  );
}

/**
 * Every bridge connection (default first) with its live state, identity and
 * mirrored workspace list — the cross-server surfaces' roster. The array
 * reference is stable per fleet-store state (zustand v5 safe).
 */
export function useFleetConnections(): ServerConnection[] {
  const { fleet } = useCrystal();
  return useStore(fleet.store, (s: FleetClientState) => s.connections);
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

/**
 * Cross-workspace runs, todos and traffic lights across EVERY connected
 * server — maps are keyed by the compound `"<sid>/<wsId>"` (see `wsKey`).
 */
export function useFleet<T>(selector: (s: FleetState) => T): T {
  const { fleetStore } = useCrystal();
  return useStore(fleetStore, selector);
}

/** Terminal panel tabs and transcripts across all workspaces and servers. */
export function useTerminals<T>(selector: (s: TerminalsState) => T): T {
  const { terminalsStore } = useCrystal();
  return useStore(terminalsStore, selector);
}

/** Multi-agent workflows of the active workspace (see `WorkflowState`). */
export function useWorkflows<T>(selector: (s: WorkflowState) => T): T {
  const { workflowStore } = useCrystal();
  return useStore(workflowStore, selector);
}

/**
 * Cross-project programs and their deliveries (see `HubState`). Unscoped
 * within a server, but per-server in the fleet (v1): this is the ACTIVE
 * connection's hub — see the note on `CrystalContextValue.hubStore`.
 */
export function useHub<T>(selector: (s: HubState) => T): T {
  const { hubStore } = useCrystal();
  return useStore(hubStore, selector);
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

/**
 * Select from the resolved global lens (spec, membership, matcher, saved
 * facets — see `LensState`). The matcher reference is stable per resolution,
 * so selecting it directly is zustand-v5 safe.
 */
export function useLens<T>(selector: (s: LensState) => T): T {
  const { lensStore } = useCrystal();
  return useStore(lensStore, selector);
}
