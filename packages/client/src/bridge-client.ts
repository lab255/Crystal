import {
  Emitter,
  UNSCOPED_METHODS,
  uid,
  type BridgeEventName,
  type BridgeEvents,
  type BridgeMethodName,
  type BridgeMethods,
  type BridgeRequest,
  type BridgeResponse,
} from "@crystal/core";

export type ConnectionState = "connecting" | "open" | "closed";

/**
 * Minimal duplex frame transport the BridgeClient drives. One instance per
 * connection attempt: the client installs the three callbacks right after the
 * factory returns, so implementations must fire them asynchronously.
 */
export interface BridgeTransport {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((text: string) => void) | null;
  onclose: (() => void) | null;
}

/** Called for every (re)connection attempt. */
export type BridgeTransportFactory = () => BridgeTransport;

/** The default transport: a browser WebSocket speaking the bridge frames. */
export function webSocketTransport(url: string): BridgeTransport {
  const ws = new WebSocket(url);
  const t: BridgeTransport = {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => t.onopen?.();
  ws.onmessage = (msg) => t.onmessage?.(String(msg.data));
  ws.onclose = () => t.onclose?.();
  ws.onerror = () => ws.close();
  return t;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Client for the Crystal bridge protocol over any frame transport — a
 * WebSocket URL (the default) or a custom transport factory (the desktop
 * shell's IPC-pipe relay). Reconnects automatically with capped backoff;
 * consumers watch `connection` events and refetch on reopen.
 */
export class BridgeClient {
  readonly events = new Emitter<
    BridgeEvents & { connection: { state: ConnectionState } }
  >();

  private transport: BridgeTransport | null = null;
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  private retryDelay = 500;
  private _state: ConnectionState = "closed";
  private scopeWs: string | null = null;

  constructor(private readonly target: string | BridgeTransportFactory) {}

  /** The WebSocket URL when connected by URL; null for custom transports. */
  get url(): string | null {
    return typeof this.target === "string" ? this.target : null;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Default workspace scope: injected as `ws` into every workspace-scoped
   * request that doesn't already carry one. Set to the active workspace id.
   */
  setScope(ws: string | null): void {
    this.scopeWs = ws;
  }

  get scope(): string | null {
    return this.scopeWs;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.events.emit("connection", { state });
  }

  private scheduleRetry(): void {
    setTimeout(() => this.open(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
  }

  private open(): void {
    if (this.transport) return; // already connecting or open
    this.setState("connecting");
    let transport: BridgeTransport;
    try {
      transport =
        typeof this.target === "string" ? webSocketTransport(this.target) : this.target();
    } catch {
      this.setState("closed");
      if (!this.closedByUser) this.scheduleRetry();
      return;
    }
    this.transport = transport;

    transport.onopen = () => {
      this.retryDelay = 500;
      this.setState("open");
    };

    transport.onmessage = (text) => {
      let data: BridgeResponse | { type: "evt"; event: BridgeEventName; payload: unknown };
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      if (data.type === "res") {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        clearTimeout(pending.timer);
        if (data.ok) pending.resolve(data.result);
        else pending.reject(new Error(data.error.message));
      } else if (data.type === "evt") {
        this.events.emit(data.event, data.payload as BridgeEvents[BridgeEventName]);
      }
    };

    transport.onclose = () => {
      if (this.transport !== transport) return;
      this.transport = null;
      this.setState("closed");
      this.failAllPending(new Error("Connection closed"));
      if (!this.closedByUser) this.scheduleRetry();
    };
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  close(): void {
    this.closedByUser = true;
    this.transport?.close();
    this.transport = null;
    this.setState("closed");
  }

  request<M extends BridgeMethodName>(
    method: M,
    params: BridgeMethods[M]["params"],
  ): Promise<BridgeMethods[M]["result"]> {
    const transport = this.transport;
    if (!transport || this._state !== "open") {
      return Promise.reject(new Error("Bridge not connected"));
    }
    const id = uid("req");
    const scoped =
      this.scopeWs !== null &&
      !(UNSCOPED_METHODS as readonly string[]).includes(method) &&
      (params as { ws?: string }).ws === undefined
        ? ({ ...params, ws: this.scopeWs } as BridgeMethods[M]["params"])
        : params;
    const req: BridgeRequest<M> = { id, type: "req", method, params: scoped };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.send(JSON.stringify(req));
    });
  }

  /** Resolves once the connection is open (immediately if already open). */
  whenOpen(): Promise<void> {
    if (this._state === "open") return Promise.resolve();
    return new Promise((resolve) => {
      const dispose = this.events.on("connection", ({ state }) => {
        if (state === "open") {
          dispose();
          resolve();
        }
      });
    });
  }
}
