import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAgentRun, type WorkerSpec } from "@crystal/core";
import type { HubEngine } from "../hub-engine.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { handleMcpRequest, isMcpRequest } from "./http.js";

/** A mock request: a Readable carrying `body` plus url/method. */
function mockReq(url: string, method: string, body: string): IncomingMessage {
  return Object.assign(Readable.from([body]), { url, method }) as unknown as IncomingMessage;
}

/** A mock response that records the status and body. */
function mockRes() {
  const rec = { status: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      rec.status = status;
      res.headersSent = true;
      return res;
    },
    end(data?: string) {
      if (data) rec.body += data;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

/** A registry whose one workspace exposes stubbed dispatch tools. */
function fakeRegistry(over: { dispatchWorker?: (runId: string, spec: WorkerSpec) => unknown } = {}) {
  const dispatchWorker = vi.fn(
    over.dispatchWorker ??
      (async (_runId: string, spec: WorkerSpec) => createAgentRun({ prompt: spec.prompt, parentRunId: "m1" })),
  );
  const manager = { ...createAgentRun({ prompt: "manage", role: "manager" }), id: "m1" };
  const runtime = {
    agents: {
      dispatchWorker,
      get: async (id: string) => (id === "m1" ? manager : null),
      listWorkersFor: async () => [{ ...createAgentRun({ prompt: "child" }), id: "w1", parentRunId: "m1" }],
    },
    orchestration: {
      projectPathForRun: async () => {
        throw new Error("no board in this fixture");
      },
    },
    workflows: {
      workflowForRun: async () => null,
    },
  };
  const registry = {
    get: (ws?: string) => {
      if (ws === "ws1") return runtime;
      throw new Error(`Unknown workspace: ${ws}`);
    },
  } as unknown as WorkspaceRegistry;
  return { registry, dispatchWorker };
}

async function post(url: string, message: unknown, reg: WorkspaceRegistry, hub?: HubEngine) {
  const { res, rec } = mockRes();
  await handleMcpRequest(mockReq(url, "POST", JSON.stringify(message)), res, reg, hub ?? null);
  return rec;
}

/** A hub stub with just the surface the endpoint touches. */
function fakeHub(over: Partial<HubEngine> = {}) {
  return {
    programIdForRun: async (runId: string) => (runId === "mgr1" ? "prog_1" : null),
    portfolioText: async () => "the portfolio",
    statusText: async (id: string) => `status of ${id}`,
    projectList: async () => ({ open: [], recent: [] }),
    ...over,
  } as unknown as HubEngine;
}

describe("isMcpRequest", () => {
  it("matches only the /mcp/ prefix", () => {
    expect(isMcpRequest("/mcp/ws1/run1")).toBe(true);
    expect(isMcpRequest("/health")).toBe(false);
    expect(isMcpRequest(undefined)).toBe(false);
  });
});

describe("handleMcpRequest", () => {
  it("routes a tools/call to the run's dispatchWorker and returns the JSON-RPC result", async () => {
    const { registry, dispatchWorker } = fakeRegistry();
    const rec = await post(
      "/mcp/ws1/m1",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_worker", arguments: { prompt: "go" } } },
      registry,
    );
    expect(dispatchWorker).toHaveBeenCalledWith("m1", { prompt: "go" });
    expect(rec.status).toBe(200);
    const reply = JSON.parse(rec.body);
    expect(reply.id).toBe(1);
    expect(reply.result.content[0].text).toMatch(/Dispatched worker/);
  });

  it("answers initialize", async () => {
    const { registry } = fakeRegistry();
    const rec = await post("/mcp/ws1/m1", { jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, registry);
    expect(JSON.parse(rec.body).result.protocolVersion).toBe("2024-11-05");
  });

  it("returns 202 with no body for a notification", async () => {
    const { registry } = fakeRegistry();
    const rec = await post("/mcp/ws1/m1", { jsonrpc: "2.0", method: "notifications/initialized" }, registry);
    expect(rec.status).toBe(202);
    expect(rec.body).toBe("");
  });

  it("404s an unknown workspace", async () => {
    const { registry } = fakeRegistry();
    const rec = await post("/mcp/nope/m1", { jsonrpc: "2.0", id: 1, method: "ping" }, registry);
    expect(rec.status).toBe(404);
  });

  it("serves the cross-project hub at /mcp/hub, unbound", async () => {
    const { registry } = fakeRegistry();
    const rec = await post(
      "/mcp/hub",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "program_status" } },
      registry,
      fakeHub(),
    );
    expect(rec.status).toBe(200);
    // No program id and no binding: the whole portfolio.
    expect(JSON.parse(rec.body).result.content[0].text).toBe("the portfolio");
  });

  it("binds /mcp/hub/<runId> to the program that run manages", async () => {
    const { registry } = fakeRegistry();
    const rec = await post(
      "/mcp/hub/mgr1",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "program_status" } },
      registry,
      fakeHub(),
    );
    expect(JSON.parse(rec.body).result.content[0].text).toBe("status of prog_1");
  });

  it("404s the hub endpoint when no hub is configured", async () => {
    const { registry } = fakeRegistry();
    const rec = await post("/mcp/hub", { jsonrpc: "2.0", id: 1, method: "ping" }, registry);
    expect(rec.status).toBe(404);
  });

  it("405s a non-POST method", async () => {
    const { registry } = fakeRegistry();
    const { res, rec } = mockRes();
    await handleMcpRequest(mockReq("/mcp/ws1/m1", "GET", ""), res, registry);
    expect(rec.status).toBe(405);
  });
});
