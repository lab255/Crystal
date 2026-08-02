import { z } from "zod";
import {
  McpRpcError,
  handleHandshake,
  invalidArgs,
  rpcFail,
  rpcOk,
  toolError,
  toolText,
  type JsonRpcMessage,
} from "./jsonrpc.js";
import {
  TaskPatchSchema,
  WorkerSpecSchema,
  WORKFLOW_STAGE_STATUSES,
  WORKFLOW_TRACK_STATUSES,
  type AgentRun,
  type ClaimResult,
  type Epic,
  type TaskItem,
  type TaskPatch,
  type WorkerSpec,
  type WorkflowStageStatus,
  type WorkflowTrack,
  type WorkflowTrackStatus,
  type AskOptions,
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

const SERVER_INFO = { name: "crystal-dispatch", version: "0.1.0" } as const;

// The envelope (handshake, reply shapes, error codes) is shared with the hub
// server — only the toolsets differ. Re-exported for the transport and tests
// that have always imported them from here.
export { McpRpcError, type JsonRpcMessage };

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
  /** Workflow control surface — present on a workflow's manager session. */
  workflow?: WorkflowTools;
}

/**
 * What a workflow's manager may do to its own workflow record: read status
 * (stages, tracks, spend vs budget), advance stages along the template's
 * dependency graph, manage parallel tracks, and declare the outcome.
 */
export interface WorkflowTools {
  status(): Promise<string>;
  advanceStage(
    stageId: string,
    status: WorkflowStageStatus,
    note?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  addTrack(init: { name: string; branch?: string | null; taskIds?: string[] }): Promise<WorkflowTrack>;
  setTrackStatus(
    trackId: string,
    status: WorkflowTrackStatus,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  mergeTrack(
    trackId: string,
  ): Promise<{ ok: true; summary: string } | { ok: false; reason: string; conflicts?: string[] }>;
  /** Record the board epic this workflow's tasks live under. */
  bindEpic(epicId: string): Promise<void>;
  complete(outcome: "completed" | "failed", summary: string): Promise<void>;
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
    ask?: AskOptions,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Close the run's own open question after an out-of-band (interactive) answer. */
  resolveQuestion(
    resolution: string,
    questionId?: string | null,
    taskId?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type { AskOptions };

/**
 * What a worker (or single task run) may do to the one task it works: read
 * it, move it, and escalate. Run identity is the write capability — no claim
 * ids to juggle; the server heartbeats/claims the lease for the run.
 */
export interface OwnTaskTools {
  detail(): Promise<string>;
  update(patch: TaskPatch): Promise<{ ok: true; task: TaskItem } | { ok: false; reason: string }>;
  askQuestion(text: string, ask?: AskOptions): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Close the run's own open question after an out-of-band (interactive) answer. */
  resolveQuestion(
    resolution: string,
    questionId?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
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
  options: z.array(z.string().min(1)).max(6).optional(),
  recommended: z.string().optional(),
});
const UpdateMyTaskArgs = z.object({ patch: TaskPatchSchema });
const ResolveQuestionArgs = z.object({
  resolution: z.string().min(1),
  questionId: z.string().optional(),
  taskId: z.string().optional(),
});

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
      branch: {
        type: "string",
        description:
          "Git branch for the worker's worktree (created at HEAD if missing). " +
          "Implies worktree isolation — use one branch per parallel track.",
      },
      purpose: { type: "string", description: "Attribution, e.g. implement, code-review, fix." },
      agentId: {
        type: "string",
        description:
          "Agent profile id from your roster — the worker runs as that agent " +
          "(its model, skills, standing instructions and tool policy apply). " +
          "Prefer this over picking a raw model.",
      },
      model: {
        type: "string",
        description:
          "Claude model alias for the worker (e.g. \"opus\" for code-intensive " +
          "work, \"sonnet\" for lighter tasks). Wins over the agentId profile's " +
          "model when both are given. Omitted = the profile's, else CLI default.",
      },
      taskId: {
        type: "string",
        description: "Board task the worker's cost and history bill to (defaults to yours).",
      },
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
    "File an async question for the task's human owner on the board. Offer " +
    "2-6 concrete answer `options` when the decision has a closed set of " +
    "choices, and name the one you `recommended` — one-click answers get " +
    "answered fastest. Do not block on the answer — keep working everything " +
    "not gated by it; the answer arrives as a follow-up turn in this session.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      taskId: { type: "string", description: "Task to attach it to (defaults to your task)." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Concrete answer choices (max 6) for one-click answering.",
      },
      recommended: {
        type: "string",
        description: "The option you recommend (must be one of `options`).",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

const RESOLVE_QUESTION_TOOL = {
  name: "resolve_question",
  description:
    "Close a question you filed with ask_question after the owner answered it " +
    "out-of-band (e.g. interactively via AskUserQuestion). Records the outcome " +
    "as the question's answer so the board stops showing it as waiting. Without " +
    "questionId it closes your newest open question.",
  inputSchema: {
    type: "object",
    properties: {
      resolution: { type: "string", description: "The decision the owner made." },
      questionId: { type: "string", description: "Question to close (defaults to your newest open one)." },
      taskId: { type: "string", description: "Task the question is on (defaults to your task)." },
    },
    required: ["resolution"],
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

const WORKFLOW_STATUS_TOOL = {
  name: "workflow_status",
  description:
    "Your workflow's full state: stages with their statuses, parallel tracks " +
    "with branches and tasks, and spend vs budget across every run. Check it " +
    "before each wave of dispatches — dispatches are refused once the budget " +
    "is exhausted or the workflow is paused.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const ADVANCE_STAGE_TOOL = {
  name: "advance_stage",
  description:
    "Move a workflow stage to a new status (pending, active, done, skipped). " +
    "Activating or completing a stage requires its dependencies to be done or " +
    "skipped. Record a note — stage notes are the workflow's durable memory.",
  inputSchema: {
    type: "object",
    properties: {
      stageId: { type: "string", description: "Stage id from workflow_status (e.g. plan, merge)." },
      status: { type: "string", enum: [...WORKFLOW_STAGE_STATUSES] },
      note: { type: "string", description: "Outcome note (plan summary, review verdict…)." },
    },
    required: ["stageId", "status"],
    additionalProperties: false,
  },
} as const;

const ADD_TRACK_TOOL = {
  name: "add_track",
  description:
    "Create a parallel development track: a named slice of the plan with its " +
    "own git branch. Dispatch that track's develop workers with the branch so " +
    "tracks never collide; reviews and fixes stay on the same branch.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Track name (e.g. \"API layer\")." },
      branch: { type: "string", description: "Branch name (defaults to wf/<workflow>/<track>)." },
      taskIds: { type: "array", items: { type: "string" }, description: "Board tasks on this track." },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

const SET_TRACK_STATUS_TOOL = {
  name: "set_track_status",
  description:
    "Update a track's status: merged once its branch landed in the main line, " +
    "abandoned if the track was cut.",
  inputSchema: {
    type: "object",
    properties: {
      trackId: { type: "string" },
      status: { type: "string", enum: [...WORKFLOW_TRACK_STATUSES] },
    },
    required: ["trackId", "status"],
    additionalProperties: false,
  },
} as const;

const MERGE_TRACK_TOOL = {
  name: "merge_track",
  description:
    "Deterministically merge a track's branch into the line checked out at " +
    "the workspace root (git merge --no-ff) and mark the track merged. On " +
    "conflict nothing is left half-merged: the merge aborts and the " +
    "conflicted files come back — dispatch a resolution worker for exactly " +
    "those. Prefer this over prompting a worker to run the merge itself.",
  inputSchema: {
    type: "object",
    properties: {
      trackId: { type: "string", description: "Track id from workflow_status." },
    },
    required: ["trackId"],
    additionalProperties: false,
  },
} as const;

const BIND_EPIC_TOOL = {
  name: "bind_epic",
  description:
    "Record the board epic this workflow's tasks live under (call it right " +
    "after create_epic so cost and progress roll up in one place).",
  inputSchema: {
    type: "object",
    properties: { epicId: { type: "string" } },
    required: ["epicId"],
    additionalProperties: false,
  },
} as const;

const COMPLETE_WORKFLOW_TOOL = {
  name: "complete_workflow",
  description:
    "Declare the workflow finished: outcome \"completed\" when the goal is " +
    "met (merged, released as planned), \"failed\" when it is genuinely " +
    "blocked. The summary should cover what shipped, what it cost, and " +
    "anything left open.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["completed", "failed"] },
      summary: { type: "string" },
    },
    required: ["outcome", "summary"],
    additionalProperties: false,
  },
} as const;

const WORKFLOW_TOOLS = [
  WORKFLOW_STATUS_TOOL,
  ADVANCE_STAGE_TOOL,
  ADD_TRACK_TOOL,
  SET_TRACK_STATUS_TOOL,
  MERGE_TRACK_TOOL,
  BIND_EPIC_TOOL,
  COMPLETE_WORKFLOW_TOOL,
] as const;

const AdvanceStageArgs = z.object({
  stageId: z.string().min(1),
  status: z.enum(WORKFLOW_STAGE_STATUSES),
  note: z.string().optional(),
});
const AddTrackArgs = z.object({
  name: z.string().min(1),
  branch: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
});
const SetTrackStatusArgs = z.object({
  trackId: z.string().min(1),
  status: z.enum(WORKFLOW_TRACK_STATUSES),
});
const MergeTrackArgs = z.object({ trackId: z.string().min(1) });
const BindEpicArgs = z.object({ epicId: z.string().min(1) });
const CompleteWorkflowArgs = z.object({
  outcome: z.enum(["completed", "failed"]),
  summary: z.string().min(1),
});

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
  RESOLVE_QUESTION_TOOL,
] as const;

const OWN_TASK_TOOLS = [
  MY_TASK_TOOL,
  UPDATE_MY_TASK_TOOL,
  ASK_QUESTION_TOOL,
  RESOLVE_QUESTION_TOOL,
] as const;

export class McpDispatchServer {
  constructor(private readonly tools: DispatchTools) {}

  /**
   * Process one decoded JSON-RPC message. Returns the response message, or null
   * for notifications (no id) which the transport must not reply to. Never
   * throws — tool failures come back as JSON-RPC errors or `isError` results.
   */
  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const id = msg.id ?? null;
    const handshake = handleHandshake(msg, SERVER_INFO);
    if (handshake !== undefined) return handshake;

    switch (msg.method) {
      case "tools/list": {
        const tools = [
          ...(this.tools.dispatch ? DISPATCH_TOOLS : []),
          ...(this.tools.workflow ? WORKFLOW_TOOLS : []),
          ...(this.tools.board ? BOARD_TOOLS : []),
          ...(this.tools.ownTask ? OWN_TASK_TOOLS : []),
        ];
        // ask_question rides both the board and ownTask groups — list it once.
        return rpcOk(id, {
          tools: tools.filter((t, i) => tools.findIndex((x) => x.name === t.name) === i),
        });
      }
      case "tools/call":
        return this.callTool(id, msg.params);
      default:
        return msg.id == null
          ? null
          : rpcFail(id, McpRpcError.MethodNotFound, `Unknown method: ${msg.method ?? "(none)"}`);
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
        return rpcFail(
          id,
          McpRpcError.InvalidParams,
          `Invalid dispatch_worker arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      try {
        const run = await dispatch.dispatchWorker(parsed.data);
        return run
          ? toolText(id, `Dispatched worker ${run.id}: ${headline(run.prompt)}`)
          : toolError(
              id,
              "Dispatch rejected — you may not be a manager run, or the worker fan-out cap was reached.",
            );
      } catch (err) {
        return toolError(id, `Dispatch failed: ${(err as Error).message}`);
      }
    }
    if (dispatch && name === "worker_status") {
      try {
        const workers = await dispatch.listWorkers();
        const text = workers.length
          ? workers.map((w) => `- ${w.id} [${w.status}] ${headline(w.prompt)}`).join("\n")
          : "No workers dispatched yet.";
        return toolText(id, text);
      } catch (err) {
        return toolError(id, `Status failed: ${(err as Error).message}`);
      }
    }
    if (dispatch && name === "worker_result") {
      const a = WorkerResultArgs.safeParse(args ?? {});
      if (!a.success) return invalidArgs(id, name!, a.error);
      try {
        const text = await dispatch.workerResult(a.data.runId);
        return text
          ? toolText(id, text)
          : toolError(id, `No worker ${a.data.runId} under this manager.`);
      } catch (err) {
        return toolError(id, `worker_result failed: ${(err as Error).message}`);
      }
    }
    const workflow = this.tools.workflow;
    if (workflow && WORKFLOW_TOOLS.some((t) => t.name === name)) {
      return this.callWorkflowTool(workflow, id, name!, args);
    }
    const own = this.tools.ownTask;
    if (own && OWN_TASK_TOOLS.some((t) => t.name === name)) {
      return this.callOwnTaskTool(own, id, name!, args);
    }
    const board = this.tools.board;
    if (board && BOARD_TOOLS.some((t) => t.name === name)) {
      return this.callBoardTool(board, id, name!, args);
    }
    return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name ?? "(none)"}`);
  }

  private async callWorkflowTool(
    workflow: WorkflowTools,
    id: string | number | null,
    name: string,
    args: unknown,
  ): Promise<JsonRpcMessage> {
    try {
      switch (name) {
        case "workflow_status":
          return toolText(id, await workflow.status());
        case "advance_stage": {
          const a = AdvanceStageArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await workflow.advanceStage(a.data.stageId, a.data.status, a.data.note);
          return result.ok
            ? toolText(id, `Stage ${a.data.stageId} → ${a.data.status}.`)
            : toolError(id, result.reason);
        }
        case "add_track": {
          const a = AddTrackArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const track = await workflow.addTrack(a.data);
          return toolText(
            id,
            `Created track ${track.id} "${track.name}" on branch ${track.branch}. ` +
              `Dispatch its develop workers with branch "${track.branch}".`,
          );
        }
        case "set_track_status": {
          const a = SetTrackStatusArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await workflow.setTrackStatus(a.data.trackId, a.data.status);
          return result.ok
            ? toolText(id, `Track ${a.data.trackId} → ${a.data.status}.`)
            : toolError(id, result.reason);
        }
        case "merge_track": {
          const a = MergeTrackArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await workflow.mergeTrack(a.data.trackId);
          if (result.ok) return toolText(id, result.summary);
          return toolError(
            id,
            result.reason +
              (result.conflicts?.length
                ? `\nConflicted files:\n${result.conflicts.join("\n")}`
                : ""),
          );
        }
        case "bind_epic": {
          const a = BindEpicArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          await workflow.bindEpic(a.data.epicId);
          return toolText(id, `Workflow bound to epic ${a.data.epicId}.`);
        }
        case "complete_workflow": {
          const a = CompleteWorkflowArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          await workflow.complete(a.data.outcome, a.data.summary);
          return toolText(
            id,
            `Workflow marked ${a.data.outcome}. Thank you — end your turn with a short wrap-up for the user.`,
          );
        }
        default:
          return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return toolError(id, `${name} failed: ${(err as Error).message}`);
    }
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
          return toolText(id, await own.detail());
        case "update_my_task": {
          const a = UpdateMyTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await own.update(a.data.patch);
          return result.ok
            ? toolText(id, `Updated ${result.task.id} [${result.task.status}] ${result.task.title}`)
            : toolError(id, result.reason);
        }
        case "ask_question": {
          const a = AskQuestionArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await own.askQuestion(a.data.question, {
            options: a.data.options,
            recommended: a.data.recommended,
          });
          return result.ok
            ? toolText(id, "Question filed for the human owner. Keep working what you can.")
            : toolError(id, result.reason);
        }
        case "resolve_question": {
          const a = ResolveQuestionArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await own.resolveQuestion(a.data.resolution, a.data.questionId ?? null);
          return result.ok
            ? toolText(id, "Question closed with the interactive answer.")
            : toolError(id, result.reason);
        }
        default:
          return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return toolError(id, `${name} failed: ${(err as Error).message}`);
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
          return toolText(id, await board.snapshot());
        case "create_epic": {
          const a = CreateEpicArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const epic = await board.createEpic(a.data.name, a.data.description);
          return toolText(id, `Created epic ${epic.id}: ${epic.name}`);
        }
        case "create_task": {
          const a = CreateTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const task = await board.createTask(a.data);
          return toolText(id, `Created task ${task.id}: ${task.title}`);
        }
        case "claim_task": {
          const a = ClaimTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await board.claimTask(a.data.taskId, a.data.ttlSeconds, a.data.claimId);
          return result.ok
            ? toolText(
                id,
                `Claimed ${a.data.taskId} until ${result.lease.expiresAt}. claimId: ${result.lease.claimId}` +
                  (result.stolen ? " (healed a stale lease)" : ""),
              )
            : toolError(id, result.reason);
        }
        case "update_task": {
          const a = UpdateTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await board.updateTask(a.data.taskId, a.data.claimId, a.data.patch);
          return result.ok
            ? toolText(id, `Updated ${result.task.id} [${result.task.status}] ${result.task.title}`)
            : toolError(id, result.reason);
        }
        case "release_task": {
          const a = ReleaseTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await board.releaseTask(a.data.taskId, a.data.claimId);
          return result.ok ? toolText(id, `Released ${a.data.taskId}.`) : toolError(id, result.reason);
        }
        case "get_task": {
          const a = GetTaskArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          return toolText(id, await board.taskDetail(a.data.taskId));
        }
        case "ask_question": {
          const a = AskQuestionArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await board.askQuestion(a.data.question, a.data.taskId ?? null, {
            options: a.data.options,
            recommended: a.data.recommended,
          });
          return result.ok
            ? toolText(id, "Question filed for the human owner. Keep driving unblocked work.")
            : toolError(id, result.reason);
        }
        case "resolve_question": {
          const a = ResolveQuestionArgs.safeParse(args ?? {});
          if (!a.success) return invalidArgs(id, name, a.error);
          const result = await board.resolveQuestion(
            a.data.resolution,
            a.data.questionId ?? null,
            a.data.taskId ?? null,
          );
          return result.ok
            ? toolText(id, "Question closed with the interactive answer.")
            : toolError(id, result.reason);
        }
        default:
          return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return toolError(id, `${name} failed: ${(err as Error).message}`);
    }
  }





}

function headline(prompt: string): string {
  const first = prompt.split("\n")[0] ?? "";
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}
