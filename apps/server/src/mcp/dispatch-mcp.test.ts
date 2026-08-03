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
        resolveQuestion: async (resolution, questionId, taskId) => {
          log("resolveQuestion", resolution, questionId, taskId);
          return { ok: true as const };
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
      "resolve_question",
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
        resolveQuestion: async (resolution, questionId) => {
          log("resolveQuestion", resolution, questionId);
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
    expect(names).toEqual(["my_task", "update_my_task", "ask_question", "resolve_question"]);
  });

  it("resolve_question closes the run's own logged question", async () => {
    const { server, calls } = workerHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "resolve_question",
        arguments: { resolution: "Owner said ship it", questionId: "q_1" },
      },
    });
    expect(JSON.stringify(res?.result)).toContain("closed");
    expect(calls.resolveQuestion).toEqual([["Owner said ship it", "q_1"]]);
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

describe("workflow tools", () => {
  function workflowHarness() {
    const calls: Record<string, unknown[]> = {};
    const note = (name: string, args: unknown[]) => (calls[name] = args);
    const workflow: NonNullable<DispatchTools["workflow"]> = {
      status: vi.fn(async () => "Workflow wf_1: Ship [running]"),
      advanceStage: vi.fn(async (...args: unknown[]) => {
        note("advanceStage", args);
        return args[0] === "merge"
          ? { ok: false as const, reason: "Stage merge requires develop, review to be done first." }
          : { ok: true as const };
      }),
      addTrack: vi.fn(async (init: { name: string; branch?: string | null }) => ({
        id: "track_1",
        name: init.name,
        branch: init.branch ?? "wf/ship/api",
        taskIds: [],
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      setTrackStatus: vi.fn(async () => ({ ok: true as const })),
      mergeTrack: vi.fn(async (trackId: string) =>
        trackId === "track_conflicted"
          ? {
              ok: false as const,
              reason: "Merging wf/ship/api hit conflicts (merge aborted, the tree is clean again).",
              conflicts: ["src/app.ts", "src/api.ts"],
            }
          : { ok: true as const, summary: "Merged wf/ship/api into the main line." },
      ),
      bindEpic: vi.fn(async () => {}),
      complete: vi.fn(async (...args: unknown[]) => {
        note("complete", args);
      }),
    };
    return { server: new McpDispatchServer({ workflow }), workflow, calls };
  }

  it("lists only the workflow group when no other tools are present", async () => {
    const { server } = workflowHarness();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual([
      "workflow_status",
      "advance_stage",
      "add_track",
      "set_track_status",
      "merge_track",
      "bind_epic",
      "complete_workflow",
    ]);
  });

  it("merge_track returns the summary, or the conflict list as a tool error", async () => {
    const { server, workflow } = workflowHarness();
    const merged = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "merge_track", arguments: { trackId: "track_1" } },
    });
    expect((merged?.result as { content: { text: string }[] }).content[0]!.text).toContain(
      "Merged wf/ship/api",
    );
    expect(workflow.mergeTrack).toHaveBeenCalledWith("track_1");

    const conflicted = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "merge_track", arguments: { trackId: "track_conflicted" } },
    });
    expect((conflicted?.result as { isError?: boolean }).isError).toBe(true);
    const text = (conflicted?.result as { content: { text: string }[] }).content[0]!.text;
    // The conflicted files ARE the handoff — the manager dispatches a
    // resolution worker scoped to exactly these.
    expect(text).toContain("Conflicted files:");
    expect(text).toContain("src/app.ts");
  });

  it("routes workflow_status, advance_stage and add_track", async () => {
    const { server, workflow } = workflowHarness();
    const status = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workflow_status" },
    });
    expect((status?.result as { content: { text: string }[] }).content[0]!.text).toContain("wf_1");

    const ok = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "advance_stage", arguments: { stageId: "plan", status: "done", note: "planned" } },
    });
    expect((ok?.result as { content: { text: string }[] }).content[0]!.text).toContain("plan → done");
    expect(workflow.advanceStage).toHaveBeenCalledWith("plan", "done", "planned");

    const blocked = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "advance_stage", arguments: { stageId: "merge", status: "active" } },
    });
    expect((blocked?.result as { isError?: boolean }).isError).toBe(true);

    const track = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "add_track", arguments: { name: "API" } },
    });
    expect((track?.result as { content: { text: string }[] }).content[0]!.text).toContain(
      'branch "wf/ship/api"',
    );
  });

  it("validates workflow tool arguments", async () => {
    const { server, workflow } = workflowHarness();
    const bad = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "advance_stage", arguments: { stageId: "plan", status: "sideways" } },
    });
    expect(bad?.error?.code).toBe(McpRpcError.InvalidParams);
    expect(workflow.advanceStage).not.toHaveBeenCalled();
  });

  it("completes the workflow with an outcome and summary", async () => {
    const { server, workflow } = workflowHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "complete_workflow",
        arguments: { outcome: "completed", summary: "Shipped." },
      },
    });
    expect((res?.result as { content: { text: string }[] }).content[0]!.text).toMatch(/completed/);
    expect(workflow.complete).toHaveBeenCalledWith("completed", "Shipped.");
  });
});

describe("McpDispatchServer permission + task-less ask tools", () => {
  function permissionHarness(over: Partial<NonNullable<DispatchTools["permission"]>> = {}) {
    const permission: NonNullable<DispatchTools["permission"]> = {
      request: vi.fn(async (_tool: string, input: unknown) => ({
        behavior: "allow" as const,
        updatedInput: input as Record<string, unknown>,
      })),
      ...over,
    };
    const ask: NonNullable<DispatchTools["ask"]> = {
      askQuestion: vi.fn(async () => ({ ok: true as const })),
    };
    return { server: new McpDispatchServer({ permission, ask }), permission, ask };
  }

  it("lists request_permission and the stream-only ask_question", async () => {
    const { server } = permissionHarness();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["ask_question", "request_permission"]);
  });

  it("does not double-list ask_question when a board already carries it", async () => {
    const board = {
      snapshot: vi.fn(async () => ""),
      taskDetail: vi.fn(async () => ""),
      createEpic: vi.fn(),
      createTask: vi.fn(),
      claimTask: vi.fn(),
      updateTask: vi.fn(),
      releaseTask: vi.fn(),
      askQuestion: vi.fn(async () => ({ ok: true as const })),
      resolveQuestion: vi.fn(async () => ({ ok: true as const })),
    } as unknown as NonNullable<DispatchTools["board"]>;
    const ask = { askQuestion: vi.fn(async () => ({ ok: true as const })) };
    const server = new McpDispatchServer({ board, ask });
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names.filter((n) => n === "ask_question")).toHaveLength(1);
    // The board's implementation answers, not the stream-only fallback.
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_question", arguments: { question: "Which DB?" } },
    });
    expect(board.askQuestion).toHaveBeenCalled();
    expect(ask.askQuestion).not.toHaveBeenCalled();
  });

  it("answers request_permission with the CLI's JSON contract in one text block", async () => {
    const { server, permission } = permissionHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "request_permission",
        arguments: {
          tool_name: "WebFetch",
          input: { url: "https://x" },
          tool_use_id: "toolu_1",
        },
      },
    });
    const content = (res?.result as { content: { type: string; text: string }[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://x" },
    });
    expect(permission.request).toHaveBeenCalledWith("WebFetch", { url: "https://x" });
  });

  it("returns a JSON deny (never a JSON-RPC error) for malformed or failing requests", async () => {
    const { server } = permissionHarness({
      request: vi.fn(async () => {
        throw new Error("broker exploded");
      }),
    });
    const malformed = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "request_permission", arguments: {} },
    });
    expect(malformed?.error).toBeUndefined();
    const deniedText = (malformed?.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(deniedText).behavior).toBe("deny");

    const failing = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "request_permission", arguments: { tool_name: "Bash" } },
    });
    expect(failing?.error).toBeUndefined();
    const failText = (failing?.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(failText)).toMatchObject({ behavior: "deny" });
    expect(JSON.parse(failText).message).toContain("broker exploded");
  });

  it("routes ask_question to the stream-only fallback when no board/task surface exists", async () => {
    const { server, ask } = permissionHarness();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ask_question", arguments: { question: "Deploy now?" } },
    });
    expect(ask.askQuestion).toHaveBeenCalledWith("Deploy now?", {
      options: undefined,
      recommended: undefined,
    });
    const text = (res?.result as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/no board task/);
  });
});
