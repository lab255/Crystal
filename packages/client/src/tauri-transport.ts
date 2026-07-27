import { Channel, invoke } from "@tauri-apps/api/core";
import {
  webSocketTransport,
  type BridgeTransport,
  type BridgeTransportFactory,
} from "./bridge-client.js";

/** Frames relayed from the Rust pipe client (see desktop lib.rs). */
type RelayEvent = { kind: "line"; data: string } | { kind: "close" };

/**
 * Connect to a bridge server's IPC pipe through the Tauri shell: JS never
 * touches the network — the Rust side owns the pipe client and relays
 * newline-delimited bridge frames over a Tauri ipc Channel. Without an
 * explicit `endpoint` the shell dials its own supervised sidecar's pipe
 * (rejecting when it has none); with one it dials any local server's pipe or
 * socket — typically discovered via {@link listBridgeInstances}.
 */
async function connectPipe(endpoint?: string): Promise<BridgeTransport> {
  const channel = new Channel<RelayEvent>();
  const t: BridgeTransport & { id: number | null; closed: boolean } = {
    id: null,
    closed: false,
    send: (text) => {
      if (t.id != null) void invoke("bridge_send", { id: t.id, line: text });
    },
    close: () => {
      t.closed = true;
      if (t.id != null) void invoke("bridge_close", { id: t.id });
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  channel.onmessage = (evt) => {
    if (evt.kind === "line") t.onmessage?.(evt.data);
    else t.onclose?.();
  };
  const id = await invoke<number>(
    "bridge_connect",
    endpoint == null ? { onEvent: channel } : { endpoint, onEvent: channel },
  );
  if (t.closed) {
    void invoke("bridge_close", { id });
    throw new Error("closed before connect");
  }
  t.id = id;
  return t;
}

/**
 * Desktop transport factory: prefer the shell's IPC pipe; fall back to the
 * dev WebSocket URL only when the shell reports no pipe at all (`tauri dev`,
 * where the workspace dev server owns the bridge on loopback TCP). A pipe
 * that exists but is momentarily down (sidecar restarting) does NOT fall back
 * — the client's retry loop re-dials the pipe, so we never silently attach to
 * some other server's TCP port.
 */
export function tauriBridgeTransport(fallbackUrl: string): BridgeTransportFactory {
  return () => {
    let inner: BridgeTransport | null = null;
    let closed = false;
    const t: BridgeTransport = {
      send: (text) => inner?.send(text),
      close: () => {
        closed = true;
        inner?.close();
      },
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    const adopt = (transport: BridgeTransport) => {
      if (closed) {
        transport.close();
        return;
      }
      inner = transport;
      transport.onopen = () => t.onopen?.();
      transport.onmessage = (text) => t.onmessage?.(text);
      transport.onclose = () => t.onclose?.();
    };
    void invoke<string | null>("bridge_endpoint")
      .then(async (endpoint) => {
        if (!endpoint) {
          adopt(webSocketTransport(fallbackUrl));
          return;
        }
        try {
          const pipe = await connectPipe();
          adopt(pipe);
          t.onopen?.();
        } catch {
          // Pipe advertised but unreachable (sidecar restarting): surface a
          // close so the client retries the pipe — never a foreign TCP port.
          t.onclose?.();
        }
      })
      .catch(() => {
        // No shell command at all (old shell / plain browser): dev fallback.
        adopt(webSocketTransport(fallbackUrl));
      });
    return t;
  };
}

/**
 * Transport for an *explicit* local IPC endpoint (an added fleet connection on
 * the desktop). No WebSocket fallback: if the pipe is down we surface a close
 * and let the BridgeClient's retry loop re-dial it — connecting to some other
 * server's TCP port instead would be silently wrong.
 */
export function tauriPipeTransport(endpoint: string): BridgeTransportFactory {
  return () => {
    let inner: BridgeTransport | null = null;
    let closed = false;
    const t: BridgeTransport = {
      send: (text) => inner?.send(text),
      close: () => {
        closed = true;
        inner?.close();
      },
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    void connectPipe(endpoint)
      .then((pipe) => {
        if (closed) {
          pipe.close();
          return;
        }
        inner = pipe;
        pipe.onmessage = (text) => t.onmessage?.(text);
        pipe.onclose = () => t.onclose?.();
        t.onopen?.();
      })
      .catch(() => {
        t.onclose?.();
      });
    return t;
  };
}

/**
 * A bridge server's discovery record from `~/.crystal/instances/<pid>.json`,
 * as surfaced by the desktop shell (lenient — the schema is still growing;
 * `token` is stripped Rust-side, `alive`/`file` are added there).
 */
export interface BridgeInstance {
  pid?: number;
  serverId?: string;
  name?: string;
  pipe?: string;
  port?: number;
  roots?: string[];
  workspaces?: { id: string; root: string; name: string }[];
  startedAt?: string;
  alive?: boolean;
  file?: string;
}

/**
 * List every local bridge server advertising itself in `~/.crystal/instances`
 * (desktop only — resolves to [] in a plain browser, where discovery is
 * impossible and connections are added by URL instead).
 */
export async function listBridgeInstances(): Promise<BridgeInstance[]> {
  try {
    const raw = await invoke<unknown[]>("list_bridge_instances");
    return raw.filter((r): r is BridgeInstance => typeof r === "object" && r !== null);
  } catch {
    return [];
  }
}

/**
 * The supervised sidecar's own IPC endpoint (null in `tauri dev` or a plain
 * browser) — used to exclude the default connection's instance file from the
 * "connect to another bridge" candidates.
 */
export async function shellBridgeEndpoint(): Promise<string | null> {
  try {
    return await invoke<string | null>("bridge_endpoint");
  } catch {
    return null;
  }
}
