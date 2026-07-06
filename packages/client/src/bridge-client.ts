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

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * WebSocket client for the Crystal bridge protocol. Reconnects automatically
 * with capped backoff; consumers watch `connection` events and refetch on
 * reopen.
 */
export class BridgeClient {
  readonly events = new Emitter<
    BridgeEvents & { connection: { state: ConnectionState } }
  >();

  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  private retryDelay = 500;
  private _state: ConnectionState = "closed";
  private scopeWs: string | null = null;

  constructor(readonly url: string) {}

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

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retryDelay = 500;
      this.setState("open");
    };

    ws.onmessage = (msg) => {
      let data: BridgeResponse | { type: "evt"; event: BridgeEventName; payload: unknown };
      try {
        data = JSON.parse(String(msg.data));
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

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState("closed");
      this.failAllPending(new Error("Connection closed"));
      if (!this.closedByUser) {
        setTimeout(() => this.open(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
      }
    };

    ws.onerror = () => {
      ws.close();
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
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }

  request<M extends BridgeMethodName>(
    method: M,
    params: BridgeMethods[M]["params"],
  ): Promise<BridgeMethods[M]["result"]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
      ws.send(JSON.stringify(req));
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
