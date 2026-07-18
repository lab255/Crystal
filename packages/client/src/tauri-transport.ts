import { Channel, invoke } from "@tauri-apps/api/core";
import {
  webSocketTransport,
  type BridgeTransport,
  type BridgeTransportFactory,
} from "./bridge-client.js";

/** Frames relayed from the Rust pipe client (see desktop lib.rs). */
type RelayEvent = { kind: "line"; data: string } | { kind: "close" };

/**
 * Connect to the sidecar's IPC pipe through the Tauri shell: JS never touches
 * the network — the Rust side owns the pipe client and relays newline-delimited
 * bridge frames over a Tauri ipc Channel. Rejects when the shell has no pipe.
 */
async function connectPipe(): Promise<BridgeTransport> {
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
  const id = await invoke<number>("bridge_connect", { onEvent: channel });
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
