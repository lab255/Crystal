import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRun } from "@crystal/core";
import type { WorkspaceRegistry, WorkspaceRuntime } from "../workspace-registry.js";
import { McpDispatchServer, type JsonRpcMessage } from "./dispatch-mcp.js";

const MCP_PREFIX = "/mcp/";

/** True if a request targets the MCP dispatch endpoint. */
export function isMcpRequest(url: string | undefined): boolean {
  return !!url && url.startsWith(MCP_PREFIX);
}

/**
 * In-process MCP endpoint over Streamable HTTP: `POST /mcp/<ws>/<runId>`.
 * Manager runs and task-attached runs are launched with an mcp-config pointing
 * here (see `AgentManager.writeMcpConfig`); the toolset is scoped to the run —
 * managers get dispatch + board tools, task-bound runs get the self-service
 * `my_task` surface — with every call landing parented to `<runId>`.
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

  // Tool groups are scoped by the run's place in the hierarchy: managers
  // drive the whole board and dispatch workers; a run bound to one task
  // (worker or board-launched task run) gets the self-service surface for
  // exactly that task, its run identity acting as the write capability.
  const run = await rt.agents.get(runId);
  const boardCtx = async () => {
    const projectPath = await rt.orchestration.projectPathForRun(run ?? {});
    return { projectPath, holder: run?.agentId ?? runId };
  };
  const isManager = run?.role === "manager";
  // A manager run tagged `workflow:<id>` also drives its workflow record.
  const workflow = isManager && run ? await rt.workflows.workflowForRun(run) : null;
  const server = new McpDispatchServer({
    workflow: workflow
      ? {
          status: () => rt.workflows.statusText(workflow.id),
          advanceStage: (stageId, status, note) =>
            rt.workflows.advanceStage(workflow.id, stageId, status, note),
          addTrack: (init) => rt.workflows.addTrack(workflow.id, init),
          setTrackStatus: (trackId, status) =>
            rt.workflows.setTrackStatus(workflow.id, trackId, status),
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
          askQuestion: async (text, taskId) => {
            const target = taskId ?? run?.taskId;
            if (!target) {
              return { ok: false as const, reason: "No task to attach the question to — pass taskId." };
            }
            return rt.orchestration.addQuestion((await boardCtx()).projectPath, target, text, runId);
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
            askQuestion: async (text) =>
              rt.orchestration.addQuestion((await boardCtx()).projectPath, run.taskId!, text, runId),
          }
        : undefined,
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
