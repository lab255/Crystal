import { describe, expect, it, vi } from "vitest";
import { createAgentRun, type AgentRun, type WorkerSpec } from "@crystal/core";
import { McpDispatchServer, McpRpcError, type DispatchTools } from "./dispatch-mcp.js";

function harness(over: Partial<DispatchTools> = {}) {
  const dispatched: WorkerSpec[] = [];
  const tools: DispatchTools = {
    dispatchWorker: vi.fn(async (spec: WorkerSpec) => {
      dispatched.push(spec);
      return createAgentRun({ prompt: spec.prompt, parentRunId: "run-manager" });
    }),
    listWorkers: vi.fn(async () => [] as AgentRun[]),
    ...over,
  };
  return { server: new McpDispatchServer(tools), tools, dispatched };
}

describe("McpDispatchServer", () => {
  it("handshakes with protocol version and server info", async () => {
    const { server } = harness();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "crystal-dispatch" },
      capabilities: { tools: {} },
    });
  });

  it("does not reply to the initialized notification", async () => {
    const { server } = harness();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("lists the dispatch tools", async () => {
    const { server } = harness();
    const res = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["dispatch_worker", "worker_status"]);
  });

  it("dispatches a worker and returns its run id", async () => {
    const { server, dispatched } = harness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "dispatch_worker", arguments: { prompt: "write the parser", isolation: "worktree" } },
    });
    expect(dispatched).toEqual([{ prompt: "write the parser", isolation: "worktree" }]);
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^Dispatched worker run.*write the parser/);
  });

  it("rejects a promptless dispatch with InvalidParams", async () => {
    const { server, tools } = harness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "dispatch_worker", arguments: { cwd: "packages/core" } },
    });
    expect(res?.error?.code).toBe(McpRpcError.InvalidParams);
    expect(tools.dispatchWorker).not.toHaveBeenCalled();
  });

  it("surfaces a guard rejection as an isError result", async () => {
    const { server } = harness({ dispatchWorker: vi.fn(async () => null) });
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "dispatch_worker", arguments: { prompt: "x" } },
    });
    const result = res?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/rejected/i);
  });

  it("reports worker status", async () => {
    const worker = { ...createAgentRun({ prompt: "do a slice" }), id: "run-w1", status: "running" as const };
    const { server } = harness({ listWorkers: vi.fn(async () => [worker]) });
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "worker_status" },
    });
    const result = res?.result as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe("- run-w1 [running] do a slice");
  });

  it("errors on an unknown method and unknown tool", async () => {
    const { server } = harness();
    const bad = await server.handle({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(bad?.error?.code).toBe(McpRpcError.MethodNotFound);
    const badTool = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(badTool?.error?.code).toBe(McpRpcError.MethodNotFound);
  });
});
