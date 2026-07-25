import type { z } from "zod";

/**
 * The JSON-RPC / MCP envelope both of Crystal's MCP servers speak. Only the
 * *toolsets* differ between them (one project, or the whole portfolio) — the
 * handshake, the reply shapes and the error codes are protocol, and belong in
 * one place so an MCP revision or an error-shape fix lands once.
 */

/** MCP revision both servers implement. */
export const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error codes we emit (subset of the spec). */
export const McpRpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A message with no `id` — the transport must not reply to it. */
export function isNotification(msg: JsonRpcMessage): boolean {
  return msg.id === undefined || msg.id === null;
}

export function rpcOk(id: string | number | null, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

export function rpcFail(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A successful tool result carrying a single text block. */
export function toolText(id: string | number | null, text: string): JsonRpcMessage {
  return rpcOk(id, { content: [{ type: "text", text }] });
}

/**
 * A tool-level failure: a normal result with `isError`, so the model reads the
 * reason and can adjust — a JSON-RPC error would look like a broken server.
 */
export function toolError(id: string | number | null, text: string): JsonRpcMessage {
  return rpcOk(id, { content: [{ type: "text", text }], isError: true });
}

/** Zod validation failure, rendered so the model can see which field was wrong. */
export function invalidArgs(
  id: string | number | null,
  tool: string,
  error: z.ZodError,
): JsonRpcMessage {
  return rpcFail(
    id,
    McpRpcError.InvalidParams,
    `Invalid ${tool} arguments: ${error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`,
  );
}

/**
 * The handshake every MCP server answers identically: `initialize`, `ping` and
 * the `notifications/initialized` no-op. Returns the reply, or `undefined`
 * when the method is not part of the handshake and the caller should handle it
 * (`null` is a real answer meaning "notification — say nothing").
 */
export function handleHandshake(
  msg: JsonRpcMessage,
  serverInfo: { name: string; version: string },
): JsonRpcMessage | null | undefined {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo,
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return isNotification(msg) ? null : rpcOk(id, {});
    default:
      return undefined;
  }
}
