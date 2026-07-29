import { z } from "zod";
import {
  dispatchReportText,
  headline,
  projectListText,
  type Program,
  type ProgramDelivery,
  type SteerReceipt,
} from "@crystal/core";
import type { DispatchReport, HubProjectRef, HubRecentProject } from "../hub-engine.js";
import {
  McpRpcError,
  handleHandshake,
  invalidArgs,
  isNotification,
  rpcFail,
  rpcOk,
  toolError,
  toolText,
  type JsonRpcMessage,
} from "./jsonrpc.js";

/**
 * The **hub** MCP server: Crystal's cross-project control surface, exposed as
 * tools to a central agent. Where `dispatch-mcp` lets a manager run drive one
 * project (dispatch workers, move the board, advance a workflow), this lets a
 * caller drive the *portfolio*: split a high-level epic into per-project
 * deliveries and hand each to that project's own orchestrator, which then runs
 * its full development flow inside the project.
 *
 * Two callers, one toolset:
 *  - an **external** central agent (Claude Code in any terminal, Claude
 *    Desktop) pointed at `POST /mcp/hub` — unbound, sees every program;
 *  - Crystal's own **program manager** run at `POST /mcp/hub/<runId>` — bound
 *    to the program it was spawned for, so `programId` defaults to its own and
 *    other programs are out of reach.
 *
 * Transport-agnostic, like the dispatch server: {@link McpHubServer.handle}
 * takes one decoded JSON-RPC message and returns the reply.
 */

const SERVER_INFO = { name: "crystal-hub", version: "0.1.0" } as const;

/**
 * The human-readable failure inside a reply that is about to be discarded, or
 * null when it succeeded. Both shapes count: a JSON-RPC `error`, and a tool
 * result flagged `isError` (which is how a refused tool call comes back).
 */
function notificationFailure(reply: JsonRpcMessage | null): string | null {
  if (!reply) return null;
  const error = (reply as { error?: { message?: string } }).error;
  if (error) return error.message ?? "unknown error";
  const result = (reply as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
  if (!result?.isError) return null;
  return result.content?.map((c) => c.text ?? "").join(" ") || "unknown tool error";
}

/** Everything the hub endpoint can do, as seen by the MCP layer. */
export interface HubToolHost {
  listProjects(): Promise<{ open: HubProjectRef[]; recent: HubRecentProject[] }>;
  resolveProject(ref: string): Promise<HubProjectRef>;
  projectBoard(ws: string): Promise<string>;
  createProgram(init: { name: string; goal: string; budgetUsd?: number | null }): Promise<Program>;
  addDelivery(
    programId: string,
    init: {
      projectRoot: string;
      projectName?: string | null;
      brief: string;
      templateId?: string | null;
      budgetUsd?: number | null;
      runCapUsd?: number | null;
      dependsOn?: string[];
    },
  ): Promise<ProgramDelivery>;
  removeDelivery(programId: string, deliveryId: string): Promise<void>;
  retryDelivery(programId: string, deliveryId: string): Promise<Program>;
  dispatch(programId: string, deliveryIds?: string[]): Promise<DispatchReport>;
  dispatchEpic(init: {
    projectRoot: string;
    name: string;
    goal: string;
    templateId?: string | null;
    budgetUsd?: number | null;
  }): Promise<{ program: Program; report: DispatchReport }>;
  /** Rendered status: one program, or the whole portfolio when `programId` is null. */
  status(programId: string | null): Promise<string>;
  answerQuestion(
    programId: string,
    questionId: string,
    answer: string,
  ): Promise<{ ok: true; resumedRunId: string | null } | { ok: false; reason: string }>;
  messageDelivery(
    programId: string,
    deliveryId: string,
    text: string,
    opts?: { wake?: boolean },
  ): Promise<{ queued: boolean } & SteerReceipt>;
  closeDelivery(
    programId: string,
    deliveryId: string,
    outcome: "completed" | "failed",
    note: string,
  ): Promise<Program>;
  compactDelivery(programId: string, deliveryId: string): Promise<void>;
  setProgramBudget(programId: string, budgetUsd: number | null): Promise<Program>;
  setDeliveryBudget(programId: string, deliveryId: string, budgetUsd: number | null): Promise<Program>;
  setPaused(programId: string, paused: boolean, reason?: string | null): Promise<Program>;
  cancel(programId: string): Promise<Program>;
  complete(programId: string, outcome: "completed" | "failed", summary: string): Promise<Program>;
  /** The program owning a delivery id — delivery-scoped tools take just that. */
  programIdForDelivery(deliveryId: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const PROJECT_ARG = {
  type: "string",
  description:
    "The project: its absolute root path, or the workspace id from list_projects. " +
    "A path that is not open yet is opened.",
} as const;

const HUB_TOOLS = [
  {
    name: "list_projects",
    description:
      "Every project this Crystal server can address: the workspaces currently " +
      "open (with their ids) and the recently-opened ones it can reopen. Start " +
      "here — you need a project reference for every dispatch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_project",
    description:
      "Bring a project under management by absolute root path. Opening is " +
      "idempotent and gives you the workspace id; dispatching to a path opens " +
      "it for you, so this is only needed to inspect a project first.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string", description: "Absolute path to the project root." } },
      required: ["root"],
      additionalProperties: false,
    },
  },
  {
    name: "project_board",
    description:
      "One project's task board: epics, tasks, statuses, blockers and cost. Read " +
      "it before writing a brief so you ask for what is not already planned there.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_ARG },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_epic",
    description:
      "THE headline tool: hand one high-level epic to one project's orchestrator " +
      "and let it run the whole development flow there (refine → plan/design → " +
      "develop/review on parallel branches → merge → release). Creates a " +
      "single-delivery program and dispatches it immediately. Returns the program " +
      "and delivery ids — poll nothing; check program_status when you want to know.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        goal: {
          type: "string",
          description:
            "What the project must deliver, as an outcome with acceptance criteria — " +
            "not implementation steps. Its orchestrator refines and plans against this.",
        },
        name: { type: "string", description: "Short program name (defaults to the goal's first line)." },
        templateId: { type: "string", description: "Workflow template id (default: the standard delivery flow)." },
        budgetUsd: { type: "number", description: "Spend ceiling in USD; work pauses when it is reached." },
      },
      required: ["project", "goal"],
      additionalProperties: false,
    },
  },
  {
    name: "create_program",
    description:
      "Create a multi-project program: one epic that several projects each " +
      "deliver part of. Follow with add_delivery per project, then " +
      "dispatch_program. For a single project, use dispatch_epic instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        goal: { type: "string", description: "The cross-project epic in full." },
        budgetUsd: { type: "number", description: "Spend ceiling across every project, in USD." },
      },
      required: ["name", "goal"],
      additionalProperties: false,
    },
  },
  {
    name: "add_delivery",
    description:
      "Add one project's share of a program. The brief is what THAT project must " +
      "deliver, written for its own orchestrator to plan against. Use dependsOn " +
      "for ordering across projects (shared API first, its consumers after) — " +
      "dependents dispatch automatically when their dependencies complete. Put the " +
      "brief's checkable factual claims on their own `assert:` lines (assert: branch X / " +
      "ref X / file X / tool X / cmd X) — they are verified against the real repo at " +
      "dispatch and failures come back on the dispatch report.",
    inputSchema: {
      type: "object",
      properties: {
        programId: { type: "string" },
        project: PROJECT_ARG,
        brief: { type: "string", description: "What this project delivers (outcomes + acceptance criteria)." },
        dependsOn: {
          type: "array",
          items: { type: "string" },
          description: "Delivery ids that must complete before this one starts.",
        },
        templateId: { type: "string", description: "Workflow template id for this project." },
        budgetUsd: { type: "number", description: "Spend ceiling for this delivery, in USD." },
        runCapUsd: {
          type: "number",
          description:
            "Per-run spend ceiling for the delivery's workflow — any single run crossing it is killed.",
        },
      },
      required: ["programId", "brief", "project"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_delivery",
    description: "Drop a delivery that has not been dispatched and that nothing depends on.",
    inputSchema: {
      type: "object",
      properties: { programId: { type: "string" }, deliveryId: { type: "string" } },
      required: ["deliveryId"],
      additionalProperties: false,
    },
  },
  {
    name: "retry_delivery",
    description:
      "Put a failed (or cancelled) delivery back in the queue so dispatch_program " +
      "can start it again with a fresh workflow. The previous attempt's work stays " +
      "in the project and its cost still counts against the program's budget. This " +
      "is the way out of a failed delivery — its dependents wait on a completion " +
      "that otherwise never comes. A completed delivery is refused: add a new " +
      "delivery instead of re-running a finished one.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        programId: { type: "string", description: "Optional — inferred from the delivery." },
      },
      required: ["deliveryId"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_program",
    description:
      "Start every ready delivery of a program — each becomes a workflow inside " +
      "its own project, driven by that project's orchestrator. Blocked deliveries " +
      "are skipped (with the reason) and dispatch themselves later, as their " +
      "dependencies complete. Safe to call repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        programId: { type: "string" },
        deliveryIds: {
          type: "array",
          items: { type: "string" },
          description: "Dispatch only these (default: everything ready).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "program_status",
    description:
      "Where the work stands: deliveries with their project, status, blockers and " +
      "workflow, what is ready to dispatch, and spend against budget. Omit " +
      "programId for the whole portfolio.",
    inputSchema: {
      type: "object",
      properties: { programId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "message_delivery",
    description:
      "Send a note into a running project orchestrator's session — a decision from " +
      "another project, a changed contract, a correction. Use this rather than " +
      "starting a second delivery in the same project. By default the note is " +
      "QUEUED for the orchestrator's next natural wake (a worker settling, a " +
      "question answered) — free, because that turn was happening anyway. Pass " +
      "wake: true only when it must be acted on before anything else settles: " +
      "that forces a resume which re-ingests the whole session and is priced " +
      "accordingly. The result is a receipt saying exactly what happened — and " +
      "note a steer can never unblock a stopped delivery; if it is waiting on a " +
      "question, answer_question is the lever.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        text: { type: "string" },
        wake: {
          type: "boolean",
          description: "Force an immediate paid resume instead of queueing (default false).",
        },
        programId: { type: "string", description: "Optional — inferred from the delivery." },
      },
      required: ["deliveryId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "close_delivery",
    description:
      "Settle a delivery from outside its workflow — for work that finished (or " +
      "became moot) by other means: you or the owner did it directly, another " +
      "delivery absorbed it, the premise changed. Records the outcome with your " +
      "note as the delivery's summary (dependents are dispatched with it), cancels " +
      "its live workflow if any, auto-dispatches whatever a completion unblocked, " +
      "and frees the project for the rest of the portfolio. Use retry_delivery to " +
      "re-run a failure; use this to declare it settled.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        outcome: { type: "string", enum: ["completed", "failed"] },
        note: {
          type: "string",
          description: "What settled it — becomes the summary its dependents receive.",
        },
        programId: { type: "string", description: "Optional — inferred from the delivery." },
      },
      required: ["deliveryId", "outcome", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "compact_delivery",
    description:
      "Checkpoint a delivery's orchestrator into a fresh session. Every wake of a " +
      "long-running orchestrator re-ingests its whole transcript; compacting retires " +
      "the transcript and reseeds a new session from the durable state (workflow " +
      "record + board), cutting the per-wake cost. Only between waves — refused " +
      "while any of the delivery's runs are live.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        programId: { type: "string", description: "Optional — inferred from the delivery." },
      },
      required: ["deliveryId"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_question",
    description:
      "Answer a question one of your projects raised (program_status lists them " +
      "under NEEDS AN ANSWER). The answer is recorded on that project's board " +
      "and handed straight back to the run that stopped for it, which resumes. " +
      "Decide cross-project questions yourself — a shared contract is the " +
      "program's call — and write the same decision into the other projects " +
      "with message_delivery so they cannot diverge.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: { type: "string", description: "From program_status." },
        answer: { type: "string", description: "The decision, in enough detail to act on." },
        programId: { type: "string", description: "Optional — defaults to yours." },
      },
      required: ["questionId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "set_program_paused",
    description:
      "Hold or release a whole program. Pausing also pauses every live project " +
      "workflow, so the spend actually stops rather than only new dispatches.",
    inputSchema: {
      type: "object",
      properties: {
        programId: { type: "string" },
        paused: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["paused"],
      additionalProperties: false,
    },
  },
  {
    name: "set_program_budget",
    description:
      "Set (or clear, with null) the program's spend ceiling in USD. Raising it " +
      "releases a program that paused because the budget ran out.",
    inputSchema: {
      type: "object",
      properties: {
        programId: { type: "string" },
        budgetUsd: { type: ["number", "null"] },
      },
      required: ["budgetUsd"],
      additionalProperties: false,
    },
  },
  {
    name: "set_delivery_budget",
    description:
      "Set (or clear) one delivery's spend ceiling, forwarded to its project " +
      "workflow. Budget each delivery so no single project can drain the program.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryId: { type: "string" },
        budgetUsd: { type: ["number", "null"] },
        programId: { type: "string", description: "Optional — inferred from the delivery." },
      },
      required: ["deliveryId", "budgetUsd"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_program",
    description:
      "Stop a program: cancel every live project workflow and mark the program " +
      "cancelled. Irreversible — prefer set_program_paused when in doubt.",
    inputSchema: {
      type: "object",
      properties: { programId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "complete_program",
    description:
      "Declare the program finished (or genuinely blocked) with a summary of what " +
      "shipped per project, what it cost, and anything left open.",
    inputSchema: {
      type: "object",
      properties: {
        programId: { type: "string" },
        outcome: { type: "string", enum: ["completed", "failed"] },
        summary: { type: "string" },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },
] as const;

/* ------------------------------------------------------------------ */
/* Argument schemas                                                    */
/* ------------------------------------------------------------------ */

const OpenProjectArgs = z.object({ root: z.string().min(1) });
const ProjectBoardArgs = z.object({ project: z.string().min(1) });
const DispatchEpicArgs = z.object({
  project: z.string().min(1),
  goal: z.string().min(1),
  name: z.string().optional(),
  templateId: z.string().nullish(),
  budgetUsd: z.number().positive().nullish(),
});
const CreateProgramArgs = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  budgetUsd: z.number().positive().nullish(),
});
const AddDeliveryArgs = z.object({
  programId: z.string().optional(),
  project: z.string().min(1),
  brief: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  templateId: z.string().nullish(),
  budgetUsd: z.number().positive().nullish(),
  runCapUsd: z.number().positive().nullish(),
});
const RemoveDeliveryArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
});
const RetryDeliveryArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
});
const DispatchProgramArgs = z.object({
  programId: z.string().optional(),
  deliveryIds: z.array(z.string()).optional(),
});
const ProgramStatusArgs = z.object({ programId: z.string().optional() });
const MessageDeliveryArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
  text: z.string().min(1),
  wake: z.boolean().optional(),
});
const CloseDeliveryArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
  outcome: z.enum(["completed", "failed"]),
  note: z.string().min(1),
});
const CompactDeliveryArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
});
const AnswerQuestionArgs = z.object({
  programId: z.string().optional(),
  questionId: z.string().min(1),
  answer: z.string().min(1),
});
const SetPausedArgs = z.object({
  programId: z.string().optional(),
  paused: z.boolean(),
  reason: z.string().optional(),
});
const SetProgramBudgetArgs = z.object({
  programId: z.string().optional(),
  budgetUsd: z.number().positive().nullable(),
});
const SetDeliveryBudgetArgs = z.object({
  programId: z.string().optional(),
  deliveryId: z.string().min(1),
  budgetUsd: z.number().positive().nullable(),
});
const CancelProgramArgs = z.object({ programId: z.string().optional() });
const CompleteProgramArgs = z.object({
  programId: z.string().optional(),
  outcome: z.enum(["completed", "failed"]),
  summary: z.string().min(1),
});

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

export interface McpHubServerOptions {
  hub: HubToolHost;
  /**
   * Program this endpoint is bound to (Crystal's own program-manager run).
   * When set, `programId` defaults to it and every tool refuses to touch
   * another program — a manager owns exactly the program it was spawned for.
   * Unset for the external endpoint, which sees the whole portfolio.
   */
  boundProgramId?: string | null;
}

export class McpHubServer {
  private readonly hub: HubToolHost;
  private readonly bound: string | null;

  constructor(opts: McpHubServerOptions) {
    this.hub = opts.hub;
    this.bound = opts.boundProgramId ?? null;
  }

  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const id = msg.id ?? null;
    const handshake = handleHandshake(msg, SERVER_INFO);
    if (handshake !== undefined) return handshake;
    // A notification carries no id, so there is nobody to answer: a reply to
    // one is an unsolicited message the client has no way to match.
    if (isNotification(msg)) {
      // The reply is discarded, so a failure would otherwise be invisible:
      // `handleMethod` turns every error into a *resolved* error frame, and
      // the caller already got its HTTP 202. Log what the reply would have
      // said before dropping it.
      const reply = await this.handleMethod(null, msg).catch((err) => {
        console.warn("[crystal] hub mcp notification threw:", (err as Error).message);
        return null;
      });
      const failure = notificationFailure(reply);
      if (failure) console.warn(`[crystal] hub mcp notification failed: ${failure}`);
      return null;
    }
    return this.handleMethod(id, msg);
  }

  private async handleMethod(
    id: string | number | null,
    msg: JsonRpcMessage,
  ): Promise<JsonRpcMessage | null> {
    switch (msg.method) {
      case "tools/list":
        // A bound manager owns one program: it neither creates new ones nor
        // reaches other people's.
        return rpcOk(id, {
          tools: HUB_TOOLS.filter((t) => !this.bound || t.name !== "create_program"),
        });
      case "tools/call":
        return this.callTool(id, msg.params);
      default:
        return rpcFail(id, McpRpcError.MethodNotFound, `Unknown method: ${msg.method ?? "(none)"}`);
    }
  }

  /**
   * Resolve the program a call targets. A bound endpoint ignores nothing and
   * accepts nothing but its own program — an explicit mismatch is an error
   * rather than a silent redirect.
   */
  private programId(explicit?: string): string {
    if (this.bound) {
      if (explicit && explicit !== this.bound) {
        throw new Error(`This session manages program ${this.bound} and cannot act on ${explicit}.`);
      }
      return this.bound;
    }
    if (!explicit) throw new Error("programId is required.");
    return explicit;
  }

  private async callTool(id: string | number | null, params: unknown): Promise<JsonRpcMessage> {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
    if (!name || !HUB_TOOLS.some((t) => t.name === name)) {
      return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name ?? "(none)"}`);
    }
    if (this.bound && name === "create_program") {
      return toolError(
        id,
        `This session manages program ${this.bound}. Use add_delivery to extend it instead of creating another program.`,
      );
    }
    try {
      return await this.run(id, name, args);
    } catch (err) {
      return toolError(id, `${name} failed: ${(err as Error).message}`);
    }
  }

  private async run(
    id: string | number | null,
    name: string,
    args: unknown,
  ): Promise<JsonRpcMessage> {
    switch (name) {
      case "list_projects": {
        const { open, recent } = await this.hub.listProjects();
        return toolText(id, projectListText(open, recent));
      }
      case "open_project": {
        const a = OpenProjectArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const project = await this.hub.resolveProject(a.data.root);
        return toolText(id, `Open: ${project.name} (ws ${project.ws}) at ${project.root}`);
      }
      case "project_board": {
        const a = ProjectBoardArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const project = await this.hub.resolveProject(a.data.project);
        return toolText(
          id,
          `Board of ${project.name} (${project.root}):\n\n${await this.hub.projectBoard(project.ws)}`,
        );
      }
      case "dispatch_epic": {
        const a = DispatchEpicArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const project = await this.hub.resolveProject(a.data.project);
        const { program, report } = await this.hub.dispatchEpic({
          projectRoot: project.root,
          name: a.data.name?.trim() || headline(a.data.goal, 80),
          goal: a.data.goal,
          templateId: a.data.templateId,
          budgetUsd: a.data.budgetUsd,
        });
        return toolText(
          id,
          [
            `Program ${program.id} "${program.name}" created for ${project.name}.`,
            dispatchReportText(report),
            "",
            "The project's orchestrator now owns the development flow. You are told when it settles; " +
              "use program_status to check in, message_delivery to steer it.",
          ].join("\n"),
        );
      }
      case "create_program": {
        const a = CreateProgramArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const program = await this.hub.createProgram(a.data);
        return toolText(
          id,
          `Created program ${program.id}: ${program.name}. Add one delivery per project with add_delivery, then dispatch_program.`,
        );
      }
      case "add_delivery": {
        const a = AddDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const project = await this.hub.resolveProject(a.data.project);
        const delivery = await this.hub.addDelivery(this.programId(a.data.programId), {
          projectRoot: project.root,
          projectName: project.name,
          brief: a.data.brief,
          dependsOn: a.data.dependsOn,
          templateId: a.data.templateId,
          budgetUsd: a.data.budgetUsd,
          runCapUsd: a.data.runCapUsd,
        });
        return toolText(
          id,
          `Added delivery ${delivery.id} → ${delivery.projectName}` +
            (delivery.dependsOn.length ? ` (blocked by ${delivery.dependsOn.join(", ")})` : "") +
            ". dispatch_program starts it when it is unblocked.",
        );
      }
      case "remove_delivery": {
        const a = RemoveDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        await this.hub.removeDelivery(programId, a.data.deliveryId);
        return toolText(id, `Removed delivery ${a.data.deliveryId}.`);
      }
      case "retry_delivery": {
        const a = RetryDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        await this.hub.retryDelivery(programId, a.data.deliveryId);
        return toolText(
          id,
          `Delivery ${a.data.deliveryId} is pending again — dispatch_program starts it when it is unblocked.`,
        );
      }
      case "dispatch_program": {
        const a = DispatchProgramArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const report = await this.hub.dispatch(this.programId(a.data.programId), a.data.deliveryIds);
        return toolText(id, dispatchReportText(report));
      }
      case "program_status": {
        const a = ProgramStatusArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        // Unbound and unspecified means the portfolio; bound always means mine.
        const target = this.bound ?? a.data.programId ?? null;
        return toolText(id, await this.hub.status(target));
      }
      case "message_delivery": {
        const a = MessageDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        const receipt = await this.hub.messageDelivery(programId, a.data.deliveryId, a.data.text, {
          wake: a.data.wake ?? false,
        });
        // The typed receipt: the caller must never be left guessing whether
        // a steer landed, is waiting, or would wait forever.
        const text =
          receipt.mode === "interactive"
            ? `Typed into ${a.data.deliveryId}'s live orchestrator terminal.`
            : receipt.mode === "resumed"
              ? `Woke ${a.data.deliveryId}'s orchestrator with it (a paid full-context resume).`
              : receipt.wakeExpected
                ? `Queued for ${a.data.deliveryId} — a run is live, so it rides the next natural wake at no extra cost.`
                : `Queued for ${a.data.deliveryId}, but NOTHING IS LIVE in that workflow — no natural wake is coming. ` +
                  `Re-send with wake: true to deliver now, answer its open question if it has one, or close/retry the delivery.`;
        return toolText(id, text);
      }
      case "close_delivery": {
        const a = CloseDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        await this.hub.closeDelivery(programId, a.data.deliveryId, a.data.outcome, a.data.note);
        return toolText(
          id,
          `Delivery ${a.data.deliveryId} closed as ${a.data.outcome}; its workflow (if live) was stopped. ` +
            `Anything a completion unblocked dispatches automatically.`,
        );
      }
      case "compact_delivery": {
        const a = CompactDeliveryArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        try {
          await this.hub.compactDelivery(programId, a.data.deliveryId);
        } catch (err) {
          return toolError(id, (err as Error).message);
        }
        return toolText(
          id,
          `Compacted ${a.data.deliveryId}'s orchestrator into a fresh session seeded from its durable state.`,
        );
      }
      case "answer_question": {
        const a = AnswerQuestionArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const result = await this.hub.answerQuestion(
          this.programId(a.data.programId),
          a.data.questionId,
          a.data.answer,
        );
        if (!result.ok) return toolError(id, result.reason);
        return toolText(
          id,
          result.resumedRunId
            ? `Answered. The run that asked resumed as ${result.resumedRunId}.`
            : "Answered and recorded on the board (the asking run was already gone).",
        );
      }
      case "set_program_paused": {
        const a = SetPausedArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const program = await this.hub.setPaused(
          this.programId(a.data.programId),
          a.data.paused,
          a.data.reason,
        );
        return toolText(id, `Program ${program.id} is now ${program.status}.`);
      }
      case "set_program_budget": {
        const a = SetProgramBudgetArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const program = await this.hub.setProgramBudget(
          this.programId(a.data.programId),
          a.data.budgetUsd,
        );
        return toolText(
          id,
          a.data.budgetUsd == null
            ? `Cleared the budget on ${program.id}.`
            : `Budget on ${program.id} is now $${a.data.budgetUsd.toFixed(2)} (status: ${program.status}).`,
        );
      }
      case "set_delivery_budget": {
        const a = SetDeliveryBudgetArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const programId = await this.resolveOwner(a.data.programId, a.data.deliveryId);
        await this.hub.setDeliveryBudget(programId, a.data.deliveryId, a.data.budgetUsd);
        return toolText(
          id,
          a.data.budgetUsd == null
            ? `Cleared the budget on ${a.data.deliveryId}.`
            : `Budget on ${a.data.deliveryId} is now $${a.data.budgetUsd.toFixed(2)}.`,
        );
      }
      case "cancel_program": {
        const a = CancelProgramArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const program = await this.hub.cancel(this.programId(a.data.programId));
        return toolText(id, `Program ${program.id} cancelled; live project workflows were stopped.`);
      }
      case "complete_program": {
        const a = CompleteProgramArgs.safeParse(args ?? {});
        if (!a.success) return invalidArgs(id, name, a.error);
        const program = await this.hub.complete(
          this.programId(a.data.programId),
          a.data.outcome,
          a.data.summary,
        );
        return toolText(
          id,
          `Program ${program.id} marked ${a.data.outcome}. End your turn with a short wrap-up for the owner.`,
        );
      }
      default:
        return rpcFail(id, McpRpcError.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  /** Program owning a delivery, honouring an explicit id and the binding. */
  private async resolveOwner(explicit: string | undefined, deliveryId: string): Promise<string> {
    if (this.bound || explicit) return this.programId(explicit);
    return this.ownerOf(deliveryId);
  }

  private async ownerOf(deliveryId: string): Promise<string> {
    const owner = await this.hub.programIdForDelivery(deliveryId);
    if (!owner) throw new Error(`Unknown delivery: ${deliveryId}`);
    return owner;
  }





}
