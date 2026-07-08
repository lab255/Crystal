import { WorkerSpecSchema, type AgentRun, type WorkerSpec } from "@crystal/core";

/**
 * A hand-rolled MCP server exposing Crystal's manager→worker dispatch as tools
 * a manager run can call. Transport-agnostic: {@link McpDispatchServer.handle}
 * takes one decoded JSON-RPC message and returns the reply (or null for
 * notifications), so the same core drives the in-process HTTP endpoint and is
 * unit-testable without a socket. See `agent.dispatchWorker` for the primitive
 * these tools wrap.
 *
 * Protocol: JSON-RPC 2.0, MCP revision 2024-11-05 — `initialize`, `ping`,
 * `tools/list`, `tools/call`, plus the `notifications/initialized` no-op.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "crystal-dispatch", version: "0.1.0" } as const;

/** JSON-RPC error codes we emit (subset of the spec). */
export const McpRpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** The dispatch primitive the tools call, scoped to one manager run. */
export interface DispatchTools {
  /** Spawn a worker under the manager; null when a guard rejects it. */
  dispatchWorker(spec: WorkerSpec): Promise<AgentRun | null>;
  /** The workers this manager has dispatched, for the status tool. */
  listWorkers(): Promise<AgentRun[]>;
}

const DISPATCH_WORKER_TOOL = {
  name: "dispatch_worker",
  description:
    "Dispatch a worker agent to carry out a subtask. The worker runs as a " +
    "tracked run parented to you, inheriting your working directory unless " +
    "overridden. Returns the worker's run id. Delegate independent pieces of " +
    "the work rather than doing them yourself.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The worker's full task instructions." },
      cwd: { type: "string", description: "Working directory relative to the workspace root." },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description: "Run the worker in a disposable git worktree instead of the repo.",
      },
      purpose: { type: "string", description: "Attribution, e.g. implement, code-review, fix." },
      tags: { type: "array", items: { type: "string" }, description: "Dimensional tags." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

const WORKER_STATUS_TOOL = {
  name: "worker_status",
  description:
    "List the workers you have dispatched and their current status (queued, " +
    "running, completed, failed, cancelled) so you can decide what to do next.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export class McpDispatchServer {
  constructor(private readonly tools: DispatchTools) {}

  /**
   * Process one decoded JSON-RPC message. Returns the response message, or null
   * for notifications (no id) which the transport must not reply to. Never
   * throws — tool failures come back as JSON-RPC errors or `isError` results.
   */
  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    const id = msg.id ?? null;

    switch (msg.method) {
      case "initialize":
        return this.ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
        return null; // notification — no reply
      case "ping":
        return isNotification ? null : this.ok(id, {});
      case "tools/list":
        return this.ok(id, { tools: [DISPATCH_WORKER_TOOL, WORKER_STATUS_TOOL] });
      case "tools/call":
        return this.callTool(id, msg.params);
      default:
        if (isNotification) return null;
        return this.fail(id, McpRpcError.MethodNotFound, `Unknown method: ${msg.method ?? "(none)"}`);
    }
  }

  private async callTool(
    id: string | number | null,
    params: unknown,
  ): Promise<JsonRpcMessage> {
    const { name, arguments: args } = (params ?? {}) as {
      name?: string;
      arguments?: unknown;
    };
    if (name === "dispatch_worker") {
      const parsed = WorkerSpecSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return this.fail(
          id,
          McpRpcError.InvalidParams,
          `Invalid dispatch_worker arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      try {
        const run = await this.tools.dispatchWorker(parsed.data);
        return run
          ? this.toolText(id, `Dispatched worker ${run.id}: ${headline(run.prompt)}`)
          : this.toolError(
              id,
              "Dispatch rejected — you may not be a manager run, or the worker fan-out cap was reached.",
            );
      } catch (err) {
        return this.toolError(id, `Dispatch failed: ${(err as Error).message}`);
      }
    }
    if (name === "worker_status") {
      try {
        const workers = await this.tools.listWorkers();
        const text = workers.length
          ? workers.map((w) => `- ${w.id} [${w.status}] ${headline(w.prompt)}`).join("\n")
          : "No workers dispatched yet.";
        return this.toolText(id, text);
      } catch (err) {
        return this.toolError(id, `Status failed: ${(err as Error).message}`);
      }
    }
    return this.fail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name ?? "(none)"}`);
  }

  private ok(id: string | number | null, result: unknown): JsonRpcMessage {
    return { jsonrpc: "2.0", id, result };
  }

  private fail(id: string | number | null, code: number, message: string): JsonRpcMessage {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  /** A successful tool result carrying a single text block. */
  private toolText(id: string | number | null, text: string): JsonRpcMessage {
    return this.ok(id, { content: [{ type: "text", text }] });
  }

  /** A tool-level failure: a normal result with `isError` so the model sees it. */
  private toolError(id: string | number | null, text: string): JsonRpcMessage {
    return this.ok(id, { content: [{ type: "text", text }], isError: true });
  }
}

function headline(prompt: string): string {
  const first = prompt.split("\n")[0] ?? "";
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}
