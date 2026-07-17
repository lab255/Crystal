import { z } from "zod";
import {
  TaskPatchSchema,
  WorkerSpecSchema,
  type AgentRun,
  type ClaimResult,
  type Epic,
  type TaskItem,
  type TaskPatch,
  type WorkerSpec,
} from "@crystal/core";

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

/**
 * The tool groups one run's MCP endpoint exposes, scoped by the run's place in
 * the hierarchy: managers get `dispatch` + `board`; runs attached to a single
 * board task (workers, task runs) get `ownTask`. Absent groups are neither
 * listed nor callable.
 */
export interface DispatchTools {
  dispatch?: {
    /** Spawn a worker under the manager; null when a guard rejects it. */
    dispatchWorker(spec: WorkerSpec): Promise<AgentRun | null>;
    /** The workers this manager has dispatched (across its resume chain). */
    listWorkers(): Promise<AgentRun[]>;
    /** Full result of one of this manager's workers; null when it isn't yours. */
    workerResult(runId: string): Promise<string | null>;
  };
  /** Board access (leases, tasks, epics) — absent when no board is available. */
  board?: BoardTools;
  /** Self-service surface for a run bound to one task. */
  ownTask?: OwnTaskTools;
}

/**
 * The board surface a manager run drives: epics + issues with lease-checked
 * writes. Implementations scope everything to the run's project and identity;
 * claim ids returned by `claimTask` are the only write capability — the
 * snapshot never reveals other holders' claims.
 */
export interface BoardTools {
  snapshot(): Promise<string>;
  taskDetail(taskId: string): Promise<string>;
  createEpic(name: string, description?: string): Promise<Epic>;
  createTask(init: {
    title: string;
    description?: string;
    epicId?: string | null;
    priority?: TaskItem["priority"];
    size?: TaskItem["size"];
    blockedBy?: string[];
  }): Promise<TaskItem>;
  claimTask(taskId: string, ttlSeconds?: number, claimId?: string): Promise<ClaimResult>;
  updateTask(
    taskId: string,
    claimId: string,
    patch: TaskPatch,
  ): Promise<{ ok: true; task: TaskItem } | { ok: false; reason: string }>;
  releaseTask(taskId: string, claimId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** File a question for a task's human owner (taskId defaults to the run's task). */
  askQuestion(
    text: string,
    taskId?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * What a worker (or single task run) may do to the one task it works: read
 * it, move it, and escalate. Run identity is the write capability — no claim
 * ids to juggle; the server heartbeats/claims the lease for the run.
 */
export interface OwnTaskTools {
  detail(): Promise<string>;
  update(patch: TaskPatch): Promise<{ ok: true; task: TaskItem } | { ok: false; reason: string }>;
  askQuestion(text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const CreateEpicArgs = z.object({ name: z.string().min(1), description: z.string().optional() });
const CreateTaskArgs = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  epicId: z.string().nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  size: z.enum(["xs", "s", "m", "l", "xl"]).nullish(),
  blockedBy: z.array(z.string()).optional(),
});
const ClaimTaskArgs = z.object({
  taskId: z.string().min(1),
  ttlSeconds: z.number().int().positive().optional(),
  claimId: z.string().optional(),
});
const UpdateTaskArgs = z.object({
  taskId: z.string().min(1),
  claimId: z.string().min(1),
  patch: TaskPatchSchema,
});
const ReleaseTaskArgs = z.object({ taskId: z.string().min(1), claimId: z.string().min(1) });
const GetTaskArgs = z.object({ taskId: z.string().min(1) });
const WorkerResultArgs = z.object({ runId: z.string().min(1) });
const AskQuestionArgs = z.object({
  question: z.string().min(1),
  taskId: z.string().optional(),
});
const UpdateMyTaskArgs = z.object({ patch: TaskPatchSchema });

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
    "running, completed, failed, cancelled). You are resumed automatically " +
    "when a worker settles — end your turn instead of polling this in a loop.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const WORKER_RESULT_TOOL = {
  name: "worker_result",
  description:
    "Full result of one of your settled workers: final message, files it " +
    "edited, and its worktree diffstat when it ran isolated. Use this to " +
    "review work and route findings before moving the task on the board.",
  inputSchema: {
    type: "object",
    properties: { runId: { type: "string", description: "The worker's run id." } },
    required: ["runId"],
    additionalProperties: false,
  },
} as const;

const BOARD_STATUS_TOOL = {
  name: "board_status",
  description:
    "The project board: epics with build cost, and every task with status, " +
    "priority, blockers, lease holder and cost. Tasks marked READY are " +
    "unblocked backlog items you may claim. The board is the single source " +
    "of truth — coordinate through it, not through worker memory.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const CREATE_EPIC_TOOL = {
  name: "create_epic",
  description: "Create an epic (a grouping of related tasks) on the project board.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

const CREATE_TASK_TOOL = {
  name: "create_task",
  description:
    "Create a task on the board. Give it a testable acceptance description, " +
    "an epic, a priority, and `blockedBy` task ids for ordering. Small, " +
    "shippable tasks beat big ones.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string", description: "What done means — testable acceptance criteria." },
      epicId: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      size: { type: "string", enum: ["xs", "s", "m", "l", "xl"] },
      blockedBy: { type: "array", items: { type: "string" }, description: "Task ids that must finish first." },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const;

const CLAIM_TASK_TOOL = {
  name: "claim_task",
  description:
    "Claim an exclusive write lease on a task before working it or updating " +
    "it — one writer per task. Returns a claimId you must pass to " +
    "update_task/release_task. Leases expire; pass your existing claimId to " +
    "heartbeat. A stale lease from a crashed agent is stolen automatically.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      ttlSeconds: { type: "number", description: "Lease duration (default 900s, max 4h)." },
      claimId: { type: "string", description: "Your existing claim, to heartbeat/extend it." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
} as const;

const UPDATE_TASK_TOOL = {
  name: "update_task",
  description:
    "Update a task you hold the lease on: status (backlog/in_progress/review/done), " +
    "title, description, priority, blockedBy, epicId, labels. Move a task to " +
    "in_progress when a worker starts, review when done+green, done after review.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      claimId: { type: "string" },
      patch: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["backlog", "in_progress", "review", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          size: { type: "string", enum: ["xs", "s", "m", "l", "xl"] },
          epicId: { type: "string" },
          blockedBy: { type: "array", items: { type: "string" } },
          labels: { type: "array", items: { type: "string" } },
          order: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    required: ["taskId", "claimId", "patch"],
    additionalProperties: false,
  },
} as const;

const RELEASE_TASK_TOOL = {
  name: "release_task",
  description: "Release your lease on a task so another writer can claim it.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      claimId: { type: "string" },
    },
    required: ["taskId", "claimId"],
    additionalProperties: false,
  },
} as const;

const GET_TASK_TOOL = {
  name: "get_task",
  description:
    "Full detail of one task: description (the acceptance criteria), " +
    "blockers with their statuses, open and answered questions, lease, runs " +
    "and cost. Read this before working a task or reviewing its result.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  },
} as const;

const ASK_QUESTION_TOOL = {
  name: "ask_question",
  description:
    "File an async question for the task's human owner on the board. Include " +
    "your recommended default. Do not block on the answer — keep working " +
    "everything not gated by it; the answer arrives as a follow-up turn.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      taskId: { type: "string", description: "Task to attach it to (defaults to your task)." },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

const MY_TASK_TOOL = {
  name: "my_task",
  description:
    "Your task's full detail: description (acceptance criteria), blockers, " +
    "questions, cost. Read it before you start.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const UPDATE_MY_TASK_TOOL = {
  name: "update_my_task",
  description:
    "Update the task you are working: move status (in_progress when you " +
    "start, review when done and green), refine the description, adjust " +
    "labels. No claim id needed — your run identity holds the lease.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["backlog", "in_progress", "review", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          size: { type: "string", enum: ["xs", "s", "m", "l", "xl"] },
          epicId: { type: "string" },
          blockedBy: { type: "array", items: { type: "string" } },
          labels: { type: "array", items: { type: "string" } },
          order: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
} as const;

const DISPATCH_TOOLS = [DISPATCH_WORKER_TOOL, WORKER_STATUS_TOOL, WORKER_RESULT_TOOL] as const;

const BOARD_TOOLS = [
  BOARD_STATUS_TOOL,
  GET_TASK_TOOL,
  CREATE_EPIC_TOOL,
  CREATE_TASK_TOOL,
  CLAIM_TASK_TOOL,
  UPDATE_TASK_TOOL,
  RELEASE_TASK_TOOL,
  ASK_QUESTION_TOOL,
] as const;

const OWN_TASK_TOOLS = [MY_TASK_TOOL, UPDATE_MY_TASK_TOOL, ASK_QUESTION_TOOL] as const;

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
      case "tools/list": {
        const tools = [
          ...(this.tools.dispatch ? DISPATCH_TOOLS : []),
          ...(this.tools.board ? BOARD_TOOLS : []),
          ...(this.tools.ownTask ? OWN_TASK_TOOLS : []),
        ];
        // ask_question rides both the board and ownTask groups — list it once.
        return this.ok(id, {
          tools: tools.filter((t, i) => tools.findIndex((x) => x.name === t.name) === i),
        });
      }
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
    const dispatch = this.tools.dispatch;
    if (dispatch && name === "dispatch_worker") {
      const parsed = WorkerSpecSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return this.fail(
          id,
          McpRpcError.InvalidParams,
          `Invalid dispatch_worker arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      try {
        const run = await dispatch.dispatchWorker(parsed.data);
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
    if (dispatch && name === "worker_status") {
      try {
        const workers = await dispatch.listWorkers();
        const text = workers.length
          ? workers.map((w) => `- ${w.id} [${w.status}] ${headline(w.prompt)}`).join("\n")
          : "No workers dispatched yet.";
        return this.toolText(id, text);
      } catch (err) {
        return this.toolError(id, `Status failed: ${(err as Error).message}`);
      }
    }
    if (dispatch && name === "worker_result") {
      const a = WorkerResultArgs.safeParse(args ?? {});
      if (!a.success) return this.invalidArgs(id, name!, a.error);
      try {
        const text = await dispatch.workerResult(a.data.runId);
        return text
          ? this.toolText(id, text)
          : this.toolError(id, `No worker ${a.data.runId} under this manager.`);
      } catch (err) {
        return this.toolError(id, `worker_result failed: ${(err as Error).message}`);
      }
    }
    const own = this.tools.ownTask;
    if (own && OWN_TASK_TOOLS.some((t) => t.name === name)) {
      return this.callOwnTaskTool(own, id, name!, args);
    }
    const board = this.tools.board;
    if (board && BOARD_TOOLS.some((t) => t.name === name)) {
      return this.callBoardTool(board, id, name!, args);
    }
    return this.fail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name ?? "(none)"}`);
  }

  private async callOwnTaskTool(
    own: OwnTaskTools,
    id: string | number | null,
    name: string,
    args: unknown,
  ): Promise<JsonRpcMessage> {
    try {
      switch (name) {
        case "my_task":
          return this.toolText(id, await own.detail());
        case "update_my_task": {
          const a = UpdateMyTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await own.update(a.data.patch);
          return result.ok
            ? this.toolText(id, `Updated ${result.task.id} [${result.task.status}] ${result.task.title}`)
            : this.toolError(id, result.reason);
        }
        case "ask_question": {
          const a = AskQuestionArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await own.askQuestion(a.data.question);
          return result.ok
            ? this.toolText(id, "Question filed for the human owner. Keep working what you can.")
            : this.toolError(id, result.reason);
        }
        default:
          return this.fail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return this.toolError(id, `${name} failed: ${(err as Error).message}`);
    }
  }

  private async callBoardTool(
    board: BoardTools,
    id: string | number | null,
    name: string,
    args: unknown,
  ): Promise<JsonRpcMessage> {
    try {
      switch (name) {
        case "board_status":
          return this.toolText(id, await board.snapshot());
        case "create_epic": {
          const a = CreateEpicArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const epic = await board.createEpic(a.data.name, a.data.description);
          return this.toolText(id, `Created epic ${epic.id}: ${epic.name}`);
        }
        case "create_task": {
          const a = CreateTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const task = await board.createTask(a.data);
          return this.toolText(id, `Created task ${task.id}: ${task.title}`);
        }
        case "claim_task": {
          const a = ClaimTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await board.claimTask(a.data.taskId, a.data.ttlSeconds, a.data.claimId);
          return result.ok
            ? this.toolText(
                id,
                `Claimed ${a.data.taskId} until ${result.lease.expiresAt}. claimId: ${result.lease.claimId}` +
                  (result.stolen ? " (healed a stale lease)" : ""),
              )
            : this.toolError(id, result.reason);
        }
        case "update_task": {
          const a = UpdateTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await board.updateTask(a.data.taskId, a.data.claimId, a.data.patch);
          return result.ok
            ? this.toolText(id, `Updated ${result.task.id} [${result.task.status}] ${result.task.title}`)
            : this.toolError(id, result.reason);
        }
        case "release_task": {
          const a = ReleaseTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await board.releaseTask(a.data.taskId, a.data.claimId);
          return result.ok ? this.toolText(id, `Released ${a.data.taskId}.`) : this.toolError(id, result.reason);
        }
        case "get_task": {
          const a = GetTaskArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          return this.toolText(id, await board.taskDetail(a.data.taskId));
        }
        case "ask_question": {
          const a = AskQuestionArgs.safeParse(args ?? {});
          if (!a.success) return this.invalidArgs(id, name, a.error);
          const result = await board.askQuestion(a.data.question, a.data.taskId ?? null);
          return result.ok
            ? this.toolText(id, "Question filed for the human owner. Keep driving unblocked work.")
            : this.toolError(id, result.reason);
        }
        default:
          return this.fail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return this.toolError(id, `${name} failed: ${(err as Error).message}`);
    }
  }

  private invalidArgs(id: string | number | null, tool: string, error: z.ZodError): JsonRpcMessage {
    return this.fail(
      id,
      McpRpcError.InvalidParams,
      `Invalid ${tool} arguments: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
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
