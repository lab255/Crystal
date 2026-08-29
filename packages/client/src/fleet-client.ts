import { createStore, type StoreApi } from "zustand/vanilla";
import {
  BRIDGE_TOKEN_PARAM,
  DEFAULT_SERVER_SID,
  Emitter,
  type WorkspaceDescriptor,
} from "@crystal/core";
import { BridgeClient, type BridgeTransportFactory, type ConnectionState } from "./bridge-client.js";
import { tauriPipeTransport } from "./tauri-transport.js";

/**
 * The fleet layer: one client, many bridges.
 *
 * The governing invariant (docs/agent-ops.md Track C): per-workspace modes stay
 * single-server — a mode tree always renders against exactly one
 * (server, workspace) pair through the active store bundle — and only the
 * cross-project layer (overview, workspace tabs, terminal panel, fleet store)
 * aggregates across connections.
 *
 * A `FleetClient` owns N named connections. The **default** connection is
 * exactly today's bootstrapping (page-origin WebSocket URL or the desktop
 * shell's supervised sidecar pipe); added connections are explicit endpoints —
 * a `ws(s)://` URL (web + desktop) or a local IPC pipe path (desktop, usually
 * discovered via `listBridgeInstances`).
 *
 * Identity: every connection has a **stable** `sid` — `"default"` for the
 * default connection, an endpoint-derived hash for added ones. The sid (not
 * the server's per-boot `serverId`) keys everything the client persists or
 * shares: compound fleet-store keys (`"<sid>/<wsId>"`), the `crystal.seenRuns`
 * payload, terminal tabs and `sid:wsId` deep links — so a server reboot never
 * orphans attention state or breaks a link. The live per-boot `serverId`
 * reported by `workspaces.list` is kept alongside for discovery dedup
 * ("is this instance file the server I'm already connected to?").
 */

/** Stable empty references for selectors (zustand v5: no literals in selectors). */
export const EMPTY_WORKSPACES: WorkspaceDescriptor[] = [];

const ROSTER_STORAGE_KEY = "crystal.bridgeRoster";
const TOKENS_STORAGE_KEY = "crystal.bridgeTokens";

/** Compound key for cross-project state: `"<sid>/<wsId>"`. */
export function wsKey(sid: string, ws: string): string {
  return `${sid}/${ws}`;
}

/** Compound key for a run in cross-project state: `"<sid>/<wsId>/<runId>"`. */
export function runKey(sid: string, ws: string, runId: string): string {
  return `${sid}/${ws}/${runId}`;
}

/** Split a compound run key. Workspace and run ids are opaque but slash-free. */
export function parseRunKey(key: string): { sid: string; ws: string; runId: string } {
  const first = key.indexOf("/");
  const second = key.indexOf("/", first + 1);
  return {
    sid: key.slice(0, first),
    ws: key.slice(first + 1, second),
    runId: key.slice(second + 1),
  };
}

/** Split a compound key; legacy bare keys resolve to the default server. */
export function parseWsKey(key: string): { sid: string; ws: string } {
  const idx = key.indexOf("/");
  if (idx === -1) return { sid: DEFAULT_SERVER_SID, ws: key };
  return { sid: key.slice(0, idx), ws: key.slice(idx + 1) };
}

/**
 * Stable connection id for an endpoint string (FNV-1a, hex). Hex-only so it
 * can never collide with the `:` of the `sid:wsId` deep-link grammar or the
 * `/` of compound keys — endpoint strings themselves contain both.
 */
export function sidForEndpoint(endpoint: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < endpoint.length; i++) {
    h ^= endpoint.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `s${(h >>> 0).toString(16)}`;
}

/** One bridge connection as plain, React-selectable data. */
export interface ServerConnection {
  /** Stable connection id — see the module doc. */
  sid: string;
  /** Endpoint string of an added connection; null for the default one. */
  endpoint: string | null;
  /** Human label: server-reported name once known, else endpoint/"this bridge". */
  label: string;
  state: ConnectionState;
  /** Per-boot id from `workspaces.list().server`; null until first response. */
  serverId: string | null;
  /** Mirrored from the connection's workspaces store (see provider wiring). */
  workspaces: WorkspaceDescriptor[];
  /** That connection's own active workspace id (last one focused on it). */
  activeWs: string | null;
}

export interface FleetClientState {
  /** Default connection first, then added ones in roster order. */
  connections: ServerConnection[];
  /** Which connection the mode tree currently renders against. */
  activeSid: string;
}

interface RosterEntry {
  endpoint: string;
  /** Cached display label so a dead server still shows its name. */
  label?: string;
}

function readJson<T>(key: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — roster/tokens are per-session then */
  }
}

/** Append a bearer token to a bridge WebSocket URL (added servers only). */
function withToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(BRIDGE_TOKEN_PARAM, token);
    return u.toString();
  } catch {
    return url;
  }
}

/** Build the transport target for an added connection's endpoint. */
function defaultMakeTarget(
  endpoint: string,
  token: string | null,
): string | BridgeTransportFactory {
  if (/^wss?:\/\//i.test(endpoint)) return withToken(endpoint, token);
  // Anything else is a local IPC pipe/socket path — desktop shell relay.
  return tauriPipeTransport(endpoint);
}

export interface FleetClientOptions {
  /** The default connection's target — exactly today's single-client bootstrap. */
  defaultTarget: string | BridgeTransportFactory;
  /** Injectable transport builder for added endpoints (tests). */
  makeTarget?: (endpoint: string, token: string | null) => string | BridgeTransportFactory;
}

export class FleetClient {
  /** `added`/`removed` fire before/after a connection's client exists, so the
   *  provider can build or tear down the matching store bundle. */
  readonly events = new Emitter<{
    added: { sid: string };
    removed: { sid: string };
  }>();

  readonly store: StoreApi<FleetClientState>;

  private readonly clients = new Map<string, BridgeClient>();
  private readonly disposers = new Map<string, () => void>();
  private readonly makeTarget: (
    endpoint: string,
    token: string | null,
  ) => string | BridgeTransportFactory;
  private readonly defaultTarget: string | BridgeTransportFactory;
  private started = false;

  constructor(opts: FleetClientOptions) {
    this.defaultTarget = opts.defaultTarget;
    this.makeTarget = opts.makeTarget ?? defaultMakeTarget;
    this.store = createStore<FleetClientState>(() => ({
      connections: [],
      activeSid: DEFAULT_SERVER_SID,
    }));
  }

  /**
   * Create the default client plus every persisted roster connection —
   * *without* touching the network, so a provider can build the runtime during
   * render (React StrictMode may discard it) and dial in an effect via
   * {@link connectAll}.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.createConnection(DEFAULT_SERVER_SID, null, "this bridge", this.defaultTarget, false);
    for (const entry of readJson<RosterEntry[]>(ROSTER_STORAGE_KEY) ?? []) {
      if (!entry || typeof entry.endpoint !== "string") continue;
      const sid = sidForEndpoint(entry.endpoint);
      if (this.clients.has(sid)) continue;
      this.createConnection(
        sid,
        entry.endpoint,
        entry.label ?? entry.endpoint,
        this.makeTarget(entry.endpoint, this.tokenFor(entry.endpoint)),
        false,
      );
    }
  }

  /** Dial every connection (idempotent; also re-dials after disconnectAll). */
  connectAll(): void {
    for (const client of this.clients.values()) client.connect();
  }

  /** Close every connection but keep the roster/records — the unmount path. */
  disconnectAll(): void {
    for (const client of this.clients.values()) client.close();
  }

  clientOf(sid: string): BridgeClient | null {
    return this.clients.get(sid) ?? null;
  }

  get defaultClient(): BridgeClient {
    const client = this.clients.get(DEFAULT_SERVER_SID);
    if (!client) throw new Error("FleetClient not started");
    return client;
  }

  get activeSid(): string {
    return this.store.getState().activeSid;
  }

  connection(sid: string): ServerConnection | null {
    return this.store.getState().connections.find((c) => c.sid === sid) ?? null;
  }

  /** Switch the active connection (the workspace to focus is the bundle's own). */
  setActive(sid: string): void {
    if (!this.clients.has(sid)) return;
    if (this.store.getState().activeSid !== sid) this.store.setState({ activeSid: sid });
  }

  /** Merge live per-connection data (workspace list mirror, identity). */
  patch(sid: string, patch: Partial<Omit<ServerConnection, "sid" | "endpoint">>): void {
    this.store.setState((s) => {
      const idx = s.connections.findIndex((c) => c.sid === sid);
      if (idx === -1) return s;
      const cur = s.connections[idx]!;
      const next = { ...cur, ...patch };
      const connections = [...s.connections];
      connections[idx] = next;
      return { connections };
    });
  }

  /**
   * Add (and persist) a connection to an explicit endpoint. The token, when
   * given, is stored in the per-endpoint map — the legacy single
   * `BRIDGE_TOKEN_COOKIE` slot stays what it always was: the default
   * connection's fallback. Returns the connection's sid.
   */
  addConnection(endpoint: string, token?: string | null, label?: string): string {
    const sid = sidForEndpoint(endpoint);
    if (token) {
      const tokens = readJson<Record<string, string>>(TOKENS_STORAGE_KEY) ?? {};
      tokens[endpoint] = token;
      writeJson(TOKENS_STORAGE_KEY, tokens);
    }
    if (!this.clients.has(sid)) {
      const roster = (readJson<RosterEntry[]>(ROSTER_STORAGE_KEY) ?? []).filter(
        (e) => e && e.endpoint !== endpoint,
      );
      roster.push({ endpoint, label });
      writeJson(ROSTER_STORAGE_KEY, roster);
      this.createConnection(
        sid,
        endpoint,
        label ?? endpoint,
        this.makeTarget(endpoint, token ?? this.tokenFor(endpoint)),
        true,
      );
    }
    return sid;
  }

  /** Disconnect, forget the persisted roster entry and its token. */
  removeConnection(sid: string): void {
    if (sid === DEFAULT_SERVER_SID) return; // the default connection is not removable
    const record = this.connection(sid);
    this.disposers.get(sid)?.();
    this.disposers.delete(sid);
    this.clients.get(sid)?.close();
    this.clients.delete(sid);
    if (record?.endpoint) {
      const roster = (readJson<RosterEntry[]>(ROSTER_STORAGE_KEY) ?? []).filter(
        (e) => e && e.endpoint !== record.endpoint,
      );
      writeJson(ROSTER_STORAGE_KEY, roster);
      const tokens = readJson<Record<string, string>>(TOKENS_STORAGE_KEY);
      if (tokens && record.endpoint in tokens) {
        delete tokens[record.endpoint];
        writeJson(TOKENS_STORAGE_KEY, tokens);
      }
    }
    this.store.setState((s) => ({
      connections: s.connections.filter((c) => c.sid !== sid),
      activeSid: s.activeSid === sid ? DEFAULT_SERVER_SID : s.activeSid,
    }));
    this.events.emit("removed", { sid });
  }

  /** Tear the fleet down for good (tests) — prefer disconnectAll in the UI. */
  close(): void {
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.started = false;
  }

  tokenFor(endpoint: string): string | null {
    const tokens = readJson<Record<string, string>>(TOKENS_STORAGE_KEY);
    const token = tokens?.[endpoint];
    return typeof token === "string" ? token : null;
  }

  private createConnection(
    sid: string,
    endpoint: string | null,
    label: string,
    target: string | BridgeTransportFactory,
    connectNow: boolean,
  ): void {
    const client = new BridgeClient(target);
    this.clients.set(sid, client);
    this.store.setState((s) => ({
      connections: [
        ...s.connections,
        {
          sid,
          endpoint,
          label,
          state: client.state,
          serverId: null,
          workspaces: EMPTY_WORKSPACES,
          activeWs: null,
        },
      ],
    }));

    // Mirror the client's connection state, and resolve the server's identity
    // on every open — a reconnect may be a different boot (new serverId) or
    // even a different server behind the same endpoint.
    const dispose = client.events.on("connection", ({ state }) => {
      this.patch(sid, { state });
      if (state === "open") {
        void client
          .request("workspaces.list", {})
          .then(({ server }) => {
            if (!server) return; // older server — sid alone identifies it
            this.patch(sid, { serverId: server.serverId, label: server.name });
            if (endpoint) this.cacheLabel(endpoint, server.name);
          })
          .catch(() => {});
      }
    });
    this.disposers.set(sid, dispose);

    // Announce before connecting so the provider's bundle wiring (which
    // subscribes to this client's events) sees the very first open.
    this.events.emit("added", { sid });
    if (connectNow) client.connect();
  }

  private cacheLabel(endpoint: string, label: string): void {
    const roster = readJson<RosterEntry[]>(ROSTER_STORAGE_KEY) ?? [];
    const entry = roster.find((e) => e && e.endpoint === endpoint);
    if (entry && entry.label !== label) {
      entry.label = label;
      writeJson(ROSTER_STORAGE_KEY, roster);
    }
  }
}
