import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  PUBLISH_PASSWORD_MIN_LEN,
  publicClientUrl,
  type HostToRelay,
  type PublishStatus,
  type RelayToHost,
} from "@crystal/core";

/**
 * Publish server: keeps ONE outbound WebSocket from this bridge server to a
 * relay (`apps/relay`, a Cloudflare Worker + Durable Object) so remote
 * browsers can reach the bridge without the local machine opening a port. The
 * relay assigns each remote client a channel; every channel becomes an
 * ordinary {@link PublishRpcClient} registered into the server's client set,
 * so relayed clients get requests *and* event broadcasts through the exact
 * same seams as a pipe or WebSocket client.
 *
 * Trust model: the Durable Object is the boundary. The host token (generated
 * here, 48 hex chars) claims the instance on first connect and is pinned by
 * the relay; remote clients authenticate with an access password the host
 * sets. The token lives only in the settings file — the bridge surface gets
 * {@link PublishStatus}, which never carries it.
 *
 * Settings follow the load-once pattern (see template-library.ts): read once,
 * kept in memory, every mutation persists before it takes effect. A corrupt
 * file degrades to the disabled default rather than failing the server.
 */

/** Server-only persisted shape (`~/.crystal/publish.json`, 0600). */
interface PublishSettings {
  enabled: boolean;
  relayUrl: string | null;
  instanceId: string | null;
  /** The relay credential — never crosses the bridge. */
  hostToken: string | null;
  /** Best-effort mirror of "a password has been set at the relay". */
  hasPassword: boolean;
}

/** Structural twin of the server's RpcClient (server.ts keeps it private). */
export interface PublishRpcClient {
  send(text: string): void;
  close(): void;
}

/**
 * Everything the manager needs from the server, as a port — so tests drive it
 * against a fake relay and a recording dispatcher, never a real server (same
 * reasoning as HubEngine's HubProjects).
 */
export interface PublishPort {
  /** Settings file path (production: `~/.crystal/publish.json`). */
  file: string;
  /** Add a relayed client to the broadcast set; returns the remover. */
  register(client: PublishRpcClient): () => void;
  /** The server's request dispatcher (null = the frame was not a request). */
  dispatchRaw(raw: string): Promise<string | null>;
  /** Status changed (connect/disconnect/config/clients) — broadcast it. */
  onChanged(status: PublishStatus): void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KEEPALIVE_MS = 30_000;

const DEFAULT_SETTINGS: PublishSettings = {
  enabled: false,
  relayUrl: null,
  instanceId: null,
  hostToken: null,
  hasPassword: false,
};

/** Host-socket URL for a stored relay origin (http(s) → ws(s)). */
function hostSocketUrl(relayUrl: string, instanceId: string): string {
  const u = new URL(relayUrl);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  const base = u.toString().replace(/\/+$/, "");
  return `${base}/i/${instanceId}/host`;
}

/** Config endpoint (plain HTTP POST, ws(s) → http(s)). */
function configUrl(relayUrl: string, instanceId: string): string {
  return `${publicClientUrl(relayUrl, instanceId)}/config`;
}

export class PublishManager {
  private settings: PublishSettings = { ...DEFAULT_SETTINGS };
  private loading: Promise<void> | null = null;

  private socket: WebSocket | null = null;
  private connected = false;
  /** ch → unregister for every live relayed client. */
  private channels = new Map<string, () => void>();
  /** Password waiting to ride the next (re)connect's header. */
  private pendingPassword: string | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private keepalive: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly port: PublishPort) {}

  private ensureLoaded(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.port.file, "utf8")) as Partial<PublishSettings>;
      this.settings = {
        enabled: raw.enabled === true,
        relayUrl: typeof raw.relayUrl === "string" ? raw.relayUrl : null,
        instanceId: typeof raw.instanceId === "string" ? raw.instanceId : null,
        hostToken: typeof raw.hostToken === "string" ? raw.hostToken : null,
        hasPassword: raw.hasPassword === true,
      };
    } catch {
      // Missing or corrupt — start from the disabled default.
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.port.file), { recursive: true });
    // 0600: the file carries the host token (no-op on Windows, where the
    // profile directory ACL covers it — same treatment as the instance file).
    await fs.writeFile(this.port.file, JSON.stringify(this.settings, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /** Load settings and dial the relay if publishing was left enabled. */
  async start(): Promise<void> {
    await this.ensureLoaded();
    if (this.settings.enabled) this.connect();
  }

  async status(): Promise<PublishStatus> {
    await this.ensureLoaded();
    return this.snapshot();
  }

  /** The shareable client URL, null unless enabled and configured. */
  publicUrl(): string | null {
    const { enabled, relayUrl, instanceId } = this.settings;
    if (!enabled || !relayUrl || !instanceId) return null;
    try {
      return publicClientUrl(relayUrl, instanceId);
    } catch {
      return null;
    }
  }

  async configure(params: {
    enabled?: boolean;
    relayUrl?: string | null;
    password?: string | null;
  }): Promise<PublishStatus> {
    await this.ensureLoaded();
    // Validate onto a copy first — a rejected configure must leave the live
    // settings untouched (they may back an open relay connection).
    const prev = this.settings;
    const next: PublishSettings = { ...prev };
    if (params.relayUrl !== undefined && params.relayUrl !== next.relayUrl) {
      if (params.relayUrl !== null) new URL(params.relayUrl); // throws on garbage
      next.relayUrl = params.relayUrl;
    }
    if (params.enabled !== undefined) next.enabled = params.enabled;
    if (next.enabled && !next.relayUrl) {
      throw new Error("A relay URL is required to enable publishing.");
    }

    // First enable mints the identity. The token claims the relay instance on
    // first connect, so it must be generated before ever dialing out.
    if (next.enabled && !next.instanceId) next.instanceId = crypto.randomBytes(6).toString("hex");
    if (next.enabled && !next.hostToken) next.hostToken = crypto.randomBytes(24).toString("hex");

    const password = params.password ?? null;
    if (password !== null) {
      if (password.length < PUBLISH_PASSWORD_MIN_LEN) {
        throw new Error(`The access password must be at least ${PUBLISH_PASSWORD_MIN_LEN} characters.`);
      }
      next.hasPassword = true;
    }

    const relayChanged = next.relayUrl !== prev.relayUrl;
    this.settings = next;
    if (password !== null) this.pendingPassword = password;
    const s = next;

    // Persist before acting: a crash mid-reconnect must not lose the config.
    await this.persist();

    if (password !== null && s.relayUrl && s.instanceId && s.hostToken) {
      // Apply immediately over HTTP so a live connection needs no bounce; the
      // pending header copy stays armed until a connect actually succeeds.
      await this.postPassword(s.relayUrl, s.instanceId, s.hostToken, password);
    }

    if (!s.enabled || relayChanged) this.disconnect();
    if (s.enabled && !this.socket) this.connect();

    const status = this.snapshot();
    this.port.onChanged(status);
    return status;
  }

  /** Server shutdown: drop the relay connection and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    this.disconnect();
  }

  // --- relay connection ---------------------------------------------------

  private connect(): void {
    const { enabled, relayUrl, instanceId, hostToken } = this.settings;
    if (this.stopped || !enabled || !relayUrl || !instanceId || !hostToken) return;
    this.clearReconnect();

    let url: string;
    try {
      url = hostSocketUrl(relayUrl, instanceId);
    } catch {
      return; // unparseable stored URL — configure() validates new ones
    }
    const headers: Record<string, string> = { authorization: `Bearer ${hostToken}` };
    if (this.pendingPassword) headers["x-crystal-access-password"] = this.pendingPassword;

    const ws = new WebSocket(url, { headers });
    this.socket = ws;
    // Attached synchronously after construction (CLAUDE.md gotcha): a dial
    // failure fires next tick, and an unhandled 'error' kills the server.
    // 'ws' always follows a client error with 'close', which reconnects.
    ws.on("error", () => {});
    ws.on("open", () => {
      if (ws !== this.socket) return;
      this.connected = true;
      this.backoffMs = RECONNECT_MIN_MS;
      this.pendingPassword = null; // it rode this connect's header
      this.startKeepalive();
      this.port.onChanged(this.snapshot());
    });
    ws.on("message", (data) => {
      if (ws !== this.socket) return;
      this.onFrame(String(data));
    });
    ws.on("close", () => {
      if (ws !== this.socket) return;
      this.socket = null;
      const wasConnected = this.connected;
      this.teardown();
      if (wasConnected || this.channels.size > 0) this.port.onChanged(this.snapshot());
      this.scheduleReconnect();
    });
  }

  private disconnect(): void {
    this.clearReconnect();
    this.backoffMs = RECONNECT_MIN_MS;
    const ws = this.socket;
    this.socket = null; // detach handlers-by-generation before closing
    const wasUp = this.connected || this.channels.size > 0;
    this.teardown();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already dead */
      }
    }
    if (wasUp && !this.stopped) this.port.onChanged(this.snapshot());
  }

  /** Drop every relayed client and stop the keepalive (socket already gone). */
  private teardown(): void {
    this.connected = false;
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const unregister of this.channels.values()) unregister();
    this.channels.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.settings.enabled || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.reconnectTimer.unref?.();
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      try {
        // The relay auto-responds "crystal:pong"; onFrame ignores it.
        this.socket?.send("crystal:ping");
      } catch {
        /* close handler owns recovery */
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  // --- channel plumbing ---------------------------------------------------

  private sendFrame(msg: HostToRelay): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      /* socket died mid-send; the close handler tears channels down */
    }
  }

  private onFrame(text: string): void {
    if (text === "crystal:pong") return;
    let msg: RelayToHost;
    try {
      msg = JSON.parse(text) as RelayToHost;
    } catch {
      return;
    }
    switch (msg.t) {
      case "ready":
        // Informational: the relay drops stranded clients when a host socket
        // dies, so live channels always re-open themselves after this.
        return;
      case "open": {
        const ch = msg.ch;
        if (this.channels.has(ch)) return;
        const client: PublishRpcClient = {
          send: (frame) => this.sendFrame({ t: "msg", ch, d: frame }),
          // The server's shutdown loop calls close() on every client.
          close: () => this.dropChannel(ch, true),
        };
        this.channels.set(ch, this.port.register(client));
        this.port.onChanged(this.snapshot());
        return;
      }
      case "msg": {
        const ch = msg.ch;
        void this.port.dispatchRaw(msg.d).then((res) => {
          if (res && this.channels.has(ch)) this.sendFrame({ t: "msg", ch, d: res });
        });
        return;
      }
      case "close":
        this.dropChannel(msg.ch, false);
        return;
    }
  }

  private dropChannel(ch: string, notifyRelay: boolean): void {
    const unregister = this.channels.get(ch);
    if (!unregister) return;
    this.channels.delete(ch);
    unregister();
    if (notifyRelay) this.sendFrame({ t: "close", ch });
    this.port.onChanged(this.snapshot());
  }

  // --- misc ---------------------------------------------------------------

  private async postPassword(
    relayUrl: string,
    instanceId: string,
    hostToken: string,
    password: string,
  ): Promise<void> {
    try {
      await fetch(configUrl(relayUrl, instanceId), {
        method: "POST",
        headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      // Applied — no need to re-set it on the next reconnect (setting a
      // password invalidates every remote session, so don't do it twice).
      this.pendingPassword = null;
    } catch {
      // Relay unreachable: the pending header copy applies it on reconnect.
    }
  }

  private snapshot(): PublishStatus {
    const s = this.settings;
    return {
      enabled: s.enabled,
      relayUrl: s.relayUrl,
      instanceId: s.instanceId,
      connected: this.connected,
      clients: this.channels.size,
      publicUrl: this.publicUrl(),
      hasPassword: s.hasPassword,
    };
  }
}
