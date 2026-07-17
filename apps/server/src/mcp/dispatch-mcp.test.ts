import { describe, expect, it, vi } from "vitest";
import { createAgentRun, createTask, type AgentRun, type WorkerSpec } from "@crystal/core";
import { McpDispatchServer, McpRpcError, type DispatchTools } from "./dispatch-mcp.js";

function harness(over: Partial<NonNullable<DispatchTools["dispatch"]>> = {}) {
  const dispatched: WorkerSpec[] = [];
  const dispatch: NonNullable<DispatchTools["dispatch"]> = {
    dispatchWorker: vi.fn(async (spec: WorkerSpec) => {
      dispatched.push(spec);
      return createAgentRun({ prompt: spec.prompt, parentRunId: "run-manager" });
    }),
    listWorkers: vi.fn(async () => [] as AgentRun[]),
    workerResult: vi.fn(async () => null),
    ...over,
  };
  return { server: new McpDispatchServer({ dispatch }), dispatch, dispatched };
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
    expect(names).toEqual(["dispatch_worker", "worker_status", "worker_result"]);
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
    const { server, dispatch } = harness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "dispatch_worker", arguments: { cwd: "packages/core" } },
    });
    expect(res?.error?.code).toBe(McpRpcError.InvalidParams);
    expect(dispatch.dispatchWorker).not.toHaveBeenCalled();
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

  it("returns a worker's result, and an isError for a worker that is not yours", async () => {
    const { server } = harness({
      workerResult: vi.fn(async (runId: string) =>
        runId === "run-w1" ? "Worker run-w1 [completed]\n\nAll tests green." : null,
      ),
    });
    const ok = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "worker_result", arguments: { runId: "run-w1" } },
    });
    expect((ok?.result as { content: { text: string }[] }).content[0]!.text).toContain("tests green");
    const missing = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "worker_result", arguments: { runId: "run-nope" } },
    });
    expect((missing?.result as { isError?: boolean }).isError).toBe(true);
  });

  it("errors on an unknown method and unknown tool", async () => {
    const { server } = harness();
    const bad = await server.handle({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(bad?.error?.code).toBe(McpRpcError.MethodNotFound);
    const badTool = await server.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(badTool?.error?.code).toBe(McpRpcError.MethodNotFound);
  });
});

describe("McpDispatchServer board tools", () => {
  function boardHarness() {
    const calls: Record<string, unknown[]> = {};
    const log = (name: string, ...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
    const { server, tools } = harnessWithBoard(log);
    return { server, tools, calls };
  }

  function harnessWithBoard(log: (name: string, ...args: unknown[]) => void) {
    const tools: DispatchTools = {
      dispatch: {
        dispatchWorker: vi.fn(async () => null),
        listWorkers: vi.fn(async () => []),
        workerResult: vi.fn(async () => null),
      },
      board: {
        snapshot: async () => {
          log("snapshot");
          return "Board: General\n- task_1 [backlog] Do it · READY";
        },
        taskDetail: async (taskId) => {
          log("taskDetail", taskId);
          return `Task ${taskId}: Do it\n\nDescription (acceptance criteria):\ntests pass`;
        },
        createEpic: async (name, description) => {
          log("createEpic", name, description);
          return { id: "epic_1", name, description: description ?? "", cost: null };
        },
        createTask: async (init) => {
          log("createTask", init);
          return createTask(init.title);
        },
        claimTask: async (taskId, ttlSeconds, claimId) => {
          log("claimTask", taskId, ttlSeconds, claimId);
          return {
            ok: true as const,
            stolen: false,
            lease: {
              claimId: claimId ?? "claim_new",
              holder: "run-manager",
              holderRunId: "run-manager",
              acquiredAt: "2026-07-16T12:00:00Z",
              expiresAt: "2026-07-16T12:15:00Z",
            },
          };
        },
        updateTask: async (taskId, claimId, patch) => {
          log("updateTask", taskId, claimId, patch);
          if (claimId !== "claim_new") return { ok: false as const, reason: "not the holder" };
          const t = createTask("Do it");
          t.status = patch.status ?? t.status;
          return { ok: true as const, task: t };
        },
        releaseTask: async (taskId, claimId) => {
          log("releaseTask", taskId, claimId);
          return { ok: true as const };
        },
        askQuestion: async (text, taskId) => {
          log("askQuestion", text, taskId);
          return taskId || text.includes("default")
            ? { ok: true as const }
            : { ok: false as const, reason: "No task to attach the question to — pass taskId." };
        },
      },
    };
    return { server: new McpDispatchServer(tools), tools };
  }

  it("lists board tools only when a board is wired", async () => {
    const { server } = boardHarness();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual([
      "dispatch_worker",
      "worker_status",
      "worker_result",
      "board_status",
      "get_task",
      "create_epic",
      "create_task",
      "claim_task",
      "update_task",
      "release_task",
      "ask_question",
    ]);
  });

  it("returns the board snapshot", async () => {
    const { server } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "board_status", arguments: {} },
    });
    const result = res?.result as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("READY");
  });

  it("returns full task detail for get_task", async () => {
    const { server } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_task", arguments: { taskId: "task_1" } },
    });
    const result = res?.result as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("acceptance criteria");
  });

  it("claims a task and hands the claim id back to the caller", async () => {
    const { server } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "claim_task", arguments: { taskId: "task_1", ttlSeconds: 600 } },
    });
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("claimId: claim_new");
  });

  it("update with the wrong claim comes back as a tool error", async () => {
    const { server } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "update_task",
        arguments: { taskId: "task_1", claimId: "claim_wrong", patch: { status: "done" } },
      },
    });
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not the holder");
  });

  it("files a question through ask_question", async () => {
    const { server, calls } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "ask_question", arguments: { question: "ship now?", taskId: "task_1" } },
    });
    expect((res?.result as { isError?: boolean }).isError).toBeUndefined();
    expect(calls.askQuestion).toEqual([["ship now?", "task_1"]]);
  });

  it("rejects malformed board-tool arguments with InvalidParams", async () => {
    const { server } = boardHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "update_task", arguments: { taskId: "task_1" } },
    });
    expect(res?.error?.code).toBe(McpRpcError.InvalidParams);
  });

  it("board tools are unknown when no board is wired", async () => {
    const { server } = harness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "board_status", arguments: {} },
    });
    expect(res?.error?.code).toBe(McpRpcError.MethodNotFound);
  });
});

describe("McpDispatchServer own-task tools (workers)", () => {
  function workerHarness() {
    const calls: Record<string, unknown[]> = {};
    const log = (name: string, ...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
    const tools: DispatchTools = {
      ownTask: {
        detail: async () => {
          log("detail");
          return "Task task_1: Do it";
        },
        update: async (patch) => {
          log("update", patch);
          const t = createTask("Do it");
          t.status = patch.status ?? t.status;
          return { ok: true as const, task: t };
        },
        askQuestion: async (text) => {
          log("askQuestion", text);
          return { ok: true as const };
        },
      },
    };
    return { server: new McpDispatchServer(tools), calls };
  }

  it("lists exactly the self-service tools — no dispatch, no board", async () => {
    const { server } = workerHarness();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["my_task", "update_my_task", "ask_question"]);
  });

  it("updates the run's own task without a claim id", async () => {
    const { server, calls } = workerHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "update_my_task", arguments: { patch: { status: "review" } } },
    });
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("[review]");
    expect(calls.update).toEqual([[{ status: "review" }]]);
  });

  it("routes ask_question to the run's own task", async () => {
    const { server, calls } = workerHarness();
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ask_question", arguments: { question: "which schema?" } },
    });
    expect(calls.askQuestion).toEqual([["which schema?"]]);
  });

  it("cannot dispatch workers", async () => {
    const { server } = workerHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "dispatch_worker", arguments: { prompt: "sub-delegate" } },
    });
    expect(res?.error?.code).toBe(McpRpcError.MethodNotFound);
  });
});
