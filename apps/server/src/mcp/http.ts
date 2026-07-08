import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { McpDispatchServer, type JsonRpcMessage } from "./dispatch-mcp.js";

const MCP_PREFIX = "/mcp/";

/** True if a request targets the MCP dispatch endpoint. */
export function isMcpRequest(url: string | undefined): boolean {
  return !!url && url.startsWith(MCP_PREFIX);
}

/**
 * In-process MCP endpoint over Streamable HTTP: `POST /mcp/<ws>/<runId>`. Each
 * manager run is launched with an mcp-config pointing here (see
 * `AgentManager.writeMcpConfig`), so its `dispatch_worker` / `worker_status`
 * tool calls land with direct AgentManager access, parented to `<runId>`.
 *
 * Stateless: every JSON-RPC request gets a single JSON response (we never open
 * the server→client SSE stream, so GET is rejected). Notifications get 202.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: WorkspaceRegistry,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const [ws, runId] = path.slice(MCP_PREFIX.length).split("/").filter(Boolean);
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  if (!ws || !runId) {
    res.writeHead(404).end();
    return;
  }

  let rt;
  try {
    rt = registry.get(ws);
  } catch {
    res.writeHead(404).end();
    return;
  }

  const server = new McpDispatchServer({
    dispatchWorker: (spec) => rt.agents.dispatchWorker(runId, spec),
    listWorkers: async () => (await rt.agents.list()).filter((r) => r.parentRunId === runId),
  });

  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(rpcError("Parse error", -32700));
    return;
  }

  // A batch is a JSON array; a single call is one object.
  const batch = Array.isArray(payload) ? payload : [payload];
  const replies: JsonRpcMessage[] = [];
  for (const message of batch) {
    const reply = await server.handle(message as JsonRpcMessage);
    if (reply) replies.push(reply);
  }

  if (replies.length === 0) {
    res.writeHead(202).end(); // only notifications — nothing to return
    return;
  }
  const out = Array.isArray(payload) ? replies : replies[0];
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
}

function rpcError(message: string, code: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
}
