import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRun, AskOptions } from "@crystal/core";
import type { HubEngine } from "../hub-engine.js";
import type { WorkspaceRegistry, WorkspaceRuntime } from "../workspace-registry.js";
import { McpDispatchServer, type JsonRpcMessage } from "./dispatch-mcp.js";
import { McpHubServer, type HubToolHost } from "./hub-mcp.js";

const MCP_PREFIX = "/mcp/";

/**
 * Reserved first path segment for the cross-project hub. Workspace ids are
 * 12-character hex digests (`workspaceIdFor`), so this can never collide.
 */
export const HUB_MCP_ID = "hub";

/** True if a request targets the MCP dispatch endpoint. */
export function isMcpRequest(url: string | undefined): boolean {
  return !!url && url.startsWith(MCP_PREFIX);
}

/**
 * In-process MCP endpoint over Streamable HTTP. Two families of endpoint hang
 * off the same handler:
 *
 *  - `POST /mcp/<ws>/<runId>` — project scope. Manager runs and task-attached
 *    runs are launched with an mcp-config pointing here (see
 *    `AgentManager.writeMcpConfig`); the toolset is scoped to the run —
 *    managers get dispatch + board tools, task-bound runs get the self-service
 *    `my_task` surface — with every call landing parented to `<runId>`.
 *  - `POST /mcp/hub[/<runId>]` — cross-project scope. Bare, it is the endpoint
 *    an external central agent points at to dispatch epics into any project;
 *    with a run id it is Crystal's own program-manager session, bound to the
 *    one program it was spawned for.
 *
 * Stateless: every JSON-RPC request gets a single JSON response (we never open
 * the server→client SSE stream, so GET is rejected). Notifications get 202.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: WorkspaceRegistry,
  hub: HubEngine | null = null,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const [ws, runId] = path.slice(MCP_PREFIX.length).split("/").filter(Boolean);
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  if (ws === HUB_MCP_ID) {
    if (!hub) {
      res.writeHead(404).end();
      return;
    }
    // A run id binds the endpoint to that manager's program; without one the
    // caller is external and sees the whole portfolio.
    const boundProgramId = runId ? await hub.programIdForRun(runId) : null;
    await serveMcp(req, res, new McpHubServer({ hub: hubToolHost(hub), boundProgramId }));
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

  // Tool groups are scoped by the run's place in the hierarchy: managers
  // drive the whole board and dispatch workers; a run bound to one task
  // (worker or board-launched task run) gets the self-service surface for
  // exactly that task, its run identity acting as the write capability.
  const run = await rt.agents.get(runId);
  const boardCtx = async () => {
    const projectPath = await rt.orchestration.projectPathForRun(run ?? {});
    return { projectPath, holder: run?.agentId ?? runId };
  };
  /**
   * File an ask on the board and mirror it onto the run's live stream — the
   * one MCP-ask policy, shared by the board and own-task tool surfaces. (The
   * CRYSTAL_QUESTION marker path needs no mirror: its parser already emitted
   * the stream event.)
   */
  const fileAsk = async (taskId: string, text: string, ask?: AskOptions) => {
    const result = await rt.orchestration.addQuestion(
      (await boardCtx()).projectPath,
      taskId,
      text,
      // The run's tags stamp the question's origin.workflowId at creation.
      run ?? { id: runId },
      ask,
    );
    if (result.ok) rt.agents.noteQuestion(runId, text, ask);
    return result;
  };
  /**
   * Taskless asks become durable board questions whenever a project can be
   * resolved. A missing board is still a valid stream-only ask: escalation
   * must never crash or fail the calling agent's turn.
   */
  const fileTasklessAsk = async (text: string, ask?: AskOptions) => {
    if (!run) return { ok: false as const, reason: "Unknown asking run." };
    try {
      const projectPath = await rt.orchestration.projectPathForRun(run);
      const workflow = await rt.workflows.workflowForRun(run).catch(() => null);
      const result = await rt.orchestration.addQuestionForRun(
        projectPath,
        run,
        text,
        ask,
        { epicId: workflow?.epicId ?? null },
      );
      rt.agents.noteQuestion(runId, text, ask);
      return result.ok ? { ok: true as const } : result;
    } catch {
      rt.agents.noteQuestion(runId, text, ask);
      return { ok: true as const };
    }
  };
  const isManager = run?.role === "manager";
  // A manager run tagged `workflow:<id>` also drives its workflow record.
  const workflow = isManager && run ? await rt.workflows.workflowForRun(run) : null;
  const server = new McpDispatchServer({
    // Every workspace-scoped run can broker permission prompts — the spawn
    // passes `--permission-prompt-tool mcp__crystal__request_permission`, and
    // the CLI refuses to start if the tool is missing from the endpoint.
    permission: run
      ? { request: (toolName, input) => rt.permissions.request(runId, toolName, input) }
      : undefined,
    // Task-less, non-manager runs still get ask_question. The handler mints a
    // board task when possible and falls back to the live stream only when no
    // project board resolves.
    ask:
      run && !isManager && !run.taskId
        ? {
            askQuestion: fileTasklessAsk,
          }
        : undefined,
    workflow: workflow
      ? {
          status: () => rt.workflows.statusText(workflow.id),
          advanceStage: (stageId, status, note) =>
            rt.workflows.advanceStage(workflow.id, stageId, status, note),
          addTrack: (init) => rt.workflows.addTrack(workflow.id, init),
          setTrackStatus: (trackId, status) =>
            rt.workflows.setTrackStatus(workflow.id, trackId, status),
          mergeTrack: (trackId) => rt.workflows.mergeTrack(workflow.id, trackId),
          bindEpic: async (epicId) => {
            await rt.workflows.bindEpic(workflow.id, epicId);
          },
          complete: async (outcome, summary) => {
            await rt.workflows.complete(workflow.id, outcome, summary);
          },
        }
      : undefined,
    dispatch:
      run != null && run.role !== "worker"
        ? {
            dispatchWorker: (spec) => rt.agents.dispatchWorker(runId, spec),
            listWorkers: () => rt.agents.listWorkersFor(runId),
            workerResult: async (workerId) => {
              const worker = (await rt.agents.listWorkersFor(runId)).find((w) => w.id === workerId);
              if (!worker) return null;
              return formatWorkerResult(worker, rt);
            },
          }
        : undefined,
    board: isManager
      ? {
          snapshot: async () => rt.orchestration.snapshot((await boardCtx()).projectPath),
          taskDetail: async (taskId) =>
            rt.orchestration.taskDetail((await boardCtx()).projectPath, taskId),
          createEpic: async (name, description) =>
            rt.orchestration.createEpicOn((await boardCtx()).projectPath, name, description),
          createTask: async (init) =>
            rt.orchestration.createTask((await boardCtx()).projectPath, init),
          claimTask: async (taskId, ttlSeconds, claimId) => {
            const ctx = await boardCtx();
            return rt.orchestration.claimTask(ctx.projectPath, taskId, {
              holder: ctx.holder,
              holderRunId: runId,
              claimId,
              ttlMs: ttlSeconds != null ? ttlSeconds * 1000 : undefined,
            });
          },
          updateTask: async (taskId, claimId, patch) =>
            rt.orchestration.updateTask((await boardCtx()).projectPath, taskId, patch, { claimId }),
          releaseTask: async (taskId, claimId) =>
            rt.orchestration.releaseTask((await boardCtx()).projectPath, taskId, { claimId }),
          askQuestion: async (text, taskId, ask) => {
            const target = taskId ?? run?.taskId;
            if (!target) return fileTasklessAsk(text, ask);
            return fileAsk(target, text, ask);
          },
          resolveQuestion: async (resolution, questionId, taskId) => {
            const target = taskId ?? run?.taskId;
            if (!target) {
              return { ok: false as const, reason: "No task to resolve the question on — pass taskId." };
            }
            return rt.orchestration.resolveQuestion(
              (await boardCtx()).projectPath,
              target,
              runId,
              resolution,
              questionId,
            );
          },
        }
      : undefined,
    ownTask:
      run?.taskId && run.role !== "manager"
        ? {
            detail: async () => rt.orchestration.taskDetail((await boardCtx()).projectPath, run.taskId!),
            update: async (patch) =>
              rt.orchestration.updateTaskAsRun(
                (await boardCtx()).projectPath,
                run.taskId!,
                { id: runId, holder: run.agentId ?? runId },
                patch,
              ),
            askQuestion: (text, ask) => fileAsk(run.taskId!, text, ask),
            resolveQuestion: async (resolution, questionId) =>
              rt.orchestration.resolveQuestion(
                (await boardCtx()).projectPath,
                run.taskId!,
                runId,
                resolution,
                questionId,
              ),
          }
        : undefined,
  });

  await serveMcp(req, res, server);
}

/** One MCP server exposed to one HTTP request/response pair. */
interface McpHandler {
  handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | null>;
}

/** Read the request body, run it through `server`, and write the reply. */
async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  server: McpHandler,
): Promise<void> {
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

/**
 * Adapt the engine to the MCP layer's view of it. Kept here rather than on
 * HubEngine so the engine stays free of any MCP concept — it is equally driven
 * by the bridge (the Hub UI) and by these tools.
 */
export function hubToolHost(hub: HubEngine): HubToolHost {
  return {
    listProjects: () => hub.projectList(),
    resolveProject: (ref) => hub.resolveProject(ref),
    projectBoard: (ws) => hub.boardSnapshot(ws),
    createProgram: (init) => hub.create(init),
    addDelivery: (programId, init) => hub.addDelivery(programId, init),
    removeDelivery: (programId, deliveryId) => hub.removeDelivery(programId, deliveryId),
    retryDelivery: (programId, deliveryId) => hub.retryDelivery(programId, deliveryId),
    dispatch: (programId, deliveryIds) => hub.dispatch(programId, deliveryIds),
    dispatchEpic: (init) => hub.dispatchEpic(init),
    status: (programId) => (programId ? hub.statusText(programId) : hub.portfolioText()),
    // Hub-manager answers are agent closures (askedBy attribution rides the
    // question's `closed.by`).
    answerQuestion: (programId, questionId, answer) =>
      hub.answerQuestion(programId, questionId, answer, undefined, "agent"),
    messageDelivery: (programId, deliveryId, text, opts) =>
      hub.messageDelivery(programId, deliveryId, text, opts),
    closeDelivery: (programId, deliveryId, outcome, note) =>
      hub.closeDelivery(programId, deliveryId, outcome, note),
    compactDelivery: (programId, deliveryId) => hub.compactDelivery(programId, deliveryId),
    setProgramBudget: (programId, budgetUsd) => hub.setBudget(programId, budgetUsd),
    setDeliveryBudget: (programId, deliveryId, budgetUsd) =>
      hub.setDeliveryBudget(programId, deliveryId, budgetUsd),
    setPaused: (programId, paused, reason) => hub.setPaused(programId, paused, reason),
    cancel: (programId) => hub.cancel(programId),
    complete: (programId, outcome, summary) => hub.complete(programId, outcome, summary),
    programIdForDelivery: (deliveryId) => hub.programIdForDelivery(deliveryId),
  };
}

function rpcError(message: string, code: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
}

const MAX_RESULT_CHARS = 10_000;

/** The full review payload for one worker: result, files touched, diffstat. */
async function formatWorkerResult(worker: AgentRun, rt: WorkspaceRuntime): Promise<string> {
  const lines = [
    `Worker ${worker.id} [${worker.status}]` +
      (worker.purpose ? ` · purpose: ${worker.purpose}` : "") +
      (worker.taskId ? ` · task: ${worker.taskId}` : ""),
  ];
  const result = (worker.resultText ?? "").trim();
  lines.push(
    "",
    result
      ? result.length > MAX_RESULT_CHARS
        ? `${result.slice(0, MAX_RESULT_CHARS)}\n… (result truncated)`
        : result
      : worker.status === "running" || worker.status === "queued"
        ? "(still running — no result yet)"
        : "(no result text)",
  );
  if (worker.filesTouched.length) {
    lines.push("", `Files touched:`, ...worker.filesTouched.map((f) => `- ${f}`));
  }
  if (worker.worktreePath) {
    const { stat } = await rt.agents.diff(worker.id).catch(() => ({ stat: "" }));
    if (stat) lines.push("", "Worktree diffstat (isolated — apply after review):", stat);
  }
  return lines.join("\n");
}
