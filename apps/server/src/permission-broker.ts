import {
  Emitter,
  toolAllowedByPatterns,
  type AgentRun,
  type PendingPermission,
} from "@crystal/core";

/**
 * Pending tool-permission requests for one workspace's headless runs.
 *
 * A `-p` run has no one at a prompt: before this existed, an ungranted tool
 * call simply failed inside a paid run. Now every headless spawn passes
 * `--permission-prompt-tool mcp__crystal__request_permission`, the CLI routes
 * each would-be prompt here as an MCP call, and the broker answers with the
 * CLI's own wire contract — a JSON `{"behavior":"allow","updatedInput":…}` or
 * `{"behavior":"deny","message":…}` (see mcp/dispatch-mcp.ts for the
 * serialization).
 *
 * Decision path, in order:
 *  1. Auto-allow when the call matches the workspace grants ledger, the run's
 *     profile allowlist, or the baseline dev-loop patterns (the same
 *     vocabulary as `--allowedTools` — see core/grants.ts).
 *  2. Otherwise the request parks: a board question is filed on the run's
 *     task (answerable as "Allow"/"Deny" like any ask), a `permission` event
 *     lands on the run's stream, and the broker waits — a grants-ledger edit
 *     that now covers the call allows it; a board answer decides it; the
 *     timeout (or the run settling) denies it with instructions to proceed
 *     differently.
 *
 * Memory is bounded by construction: a pending entry exists only while the
 * CLI holds its MCP HTTP request open, and every settle path (grant, answer,
 * timeout, run settlement, cap) removes it.
 */

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Where a pending request's board question lives (for reads and closes). */
export interface BoardQuestionRef {
  projectPath: string;
  taskId: string;
  questionId: string;
}

/** Everything the broker needs from the workspace, as a narrow port. */
export interface PermissionBrokerHost {
  run(runId: string): Promise<AgentRun | null>;
  /** The grants ledger's current patterns (re-read on every check). */
  grantPatterns(): Promise<string[]>;
  /**
   * The grants ledger's allow-all mode (re-read on every check). Optional so
   * narrow hosts stay valid; absent reads as off.
   */
  allowAll?(): Promise<boolean>;
  /** The run's profile allowlist (static per request — profiles rarely move mid-run). */
  profilePatterns(agentId: string | null): Promise<string[]>;
  /** Mirror a state change onto the run's live event stream. */
  note(runId: string, event: { tool: string; state: "pending" | "allowed" | "denied"; detail?: string }): void;
  /** File the ask on the run's board task; null when the run has no task. */
  fileQuestion(
    run: AgentRun,
    text: string,
    options: string[],
    recommended: string,
  ): Promise<BoardQuestionRef | null>;
  /** The question's answer text, when the owner has answered; null while open. */
  readAnswer(ref: BoardQuestionRef): Promise<string | null>;
  /** Close a still-open question after the broker settled without an answer. */
  closeQuestion(ref: BoardQuestionRef, runId: string, note: string): Promise<void>;
  /** Fold a denial into the grants ledger tally (the AgentsTab panel reads it). */
  onDenied(run: AgentRun, tool: string): void;
}

/**
 * How long a request may park. Deliberately under the CLI's 5-minute idle
 * timeout for HTTP MCP servers — the broker must answer while the CLI is
 * still listening, or the deny message never reaches the agent.
 */
export const PERMISSION_WAIT_MS = 4.5 * 60_000;

/** Hard cap on simultaneously parked requests (workspace-wide). */
const MAX_PENDING = 100;

/** The message a timed-out request denies with — phrased to unblock, not loop. */
const TIMEOUT_MESSAGE =
  "No decision arrived in time for this tool. Do not retry the same call now — " +
  "either accomplish the step another way, or file the decision with ask_question " +
  "and keep working everything not gated on it. The owner can pre-approve the tool " +
  "in the workspace grants panel for future runs.";

interface PendingRequest {
  runId: string;
  run: AgentRun;
  tool: string;
  summary: string;
  requestedAt: string;
  input: unknown;
  /** Profile + baseline patterns, snapshotted at request time (grants re-read live). */
  staticPatterns: string[];
  board: BoardQuestionRef | null;
  timer: NodeJS.Timeout;
  settle: (decision: PermissionDecision, note: string, allowed: boolean) => void;
}

export class PermissionBroker {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;

  constructor(
    private readonly host: PermissionBrokerHost,
    /** Always-on patterns (the dev-loop allowlist + the MCP self-grant). */
    private readonly baselinePatterns: readonly string[] = [],
    private readonly waitMs: number = PERMISSION_WAIT_MS,
  ) {}

  /** Parked request count (UI/introspection; tests assert the bound). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Snapshot of every request the IDE can currently decide, oldest first. */
  listPending(): PendingPermission[] {
    return [...this.pending].map(([id, entry]) => ({
      id,
      runId: entry.runId,
      tool: entry.tool,
      summary: entry.summary,
      requestedAt: entry.requestedAt,
    }));
  }

  /**
   * Resolve one parked request from the IDE. A stale/unknown id is an expected
   * race (the timeout, board, or grants path may have won), so it is a no-op.
   */
  resolve(id: string, decision: "allow" | "deny"): { ok: boolean } {
    if (!this.pending.has(id)) return { ok: false };
    if (decision === "allow") {
      this.settleEntry(id, { behavior: "allow" }, "allowed in the permissions panel");
    } else {
      this.settleEntry(
        id,
        {
          behavior: "deny",
          message: "The owner declined this tool use in the permissions panel. Proceed another way.",
        },
        "denied in the permissions panel",
      );
    }
    return { ok: true };
  }

  /**
   * Answer one CLI permission prompt. Never rejects — a broker failure must
   * come back as a deny the CLI can parse, not an MCP error it can't.
   */
  async request(runId: string, tool: string, input: unknown): Promise<PermissionDecision> {
    try {
      return await this.decide(runId, tool, input);
    } catch (err) {
      return {
        behavior: "deny",
        message: `Permission broker error: ${(err as Error).message}. Proceed another way or use ask_question.`,
      };
    }
  }

  private async decide(runId: string, tool: string, input: unknown): Promise<PermissionDecision> {
    const run = await this.host.run(runId);
    if (!run) return { behavior: "deny", message: `Unknown run ${runId}.` };
    const staticPatterns = [
      ...this.baselinePatterns,
      ...(await this.host.profilePatterns(run.agentId ?? null).catch(() => [] as string[])),
    ];
    // Allow-all is a broker decision, not an --allowedTools pattern: checked
    // per request so flipping it off restores prompting for the very next call.
    if (await this.host.allowAll?.().catch(() => false)) {
      return this.allowOf(input);
    }
    const grants = await this.host.grantPatterns().catch(() => [] as string[]);
    if (toolAllowedByPatterns(tool, input, [...staticPatterns, ...grants])) {
      return this.allowOf(input);
    }
    if (this.pending.size >= MAX_PENDING) {
      return {
        behavior: "deny",
        message:
          "Too many permission requests are already waiting in this workspace — proceed another way or use ask_question.",
      };
    }

    // Park it: board question (when there is a task), stream event, and the
    // three wake-ups — grants edit, board answer, timeout.
    const id = `perm_${++this.nextId}`;
    const summary = callSummary(tool, input);
    const requestedAt = new Date().toISOString();
    this.host.note(runId, { tool, state: "pending", detail: summary });
    const board = await this.host
      .fileQuestion(
        run,
        `Permission requested: ${summary}. Allow this run to use it? ` +
          `(Granting the pattern in the workspace grants panel allows it for every future run.)`,
        ["Allow", "Deny"],
        "Allow",
      )
      .catch(() => null);

    return new Promise<PermissionDecision>((resolve) => {
      const entry: PendingRequest = {
        runId,
        run,
        tool,
        summary,
        requestedAt,
        input,
        staticPatterns,
        board,
        // Keep the default-deny timer: unattended runs must never hang forever
        // waiting for an owner who may not have the IDE open.
        timer: setTimeout(
          () =>
            this.settleEntry(
              id,
              { behavior: "deny", message: TIMEOUT_MESSAGE },
              "timed out",
            ),
          this.waitMs,
        ),
        settle: (decision, note, allowed) => {
          this.host.note(runId, {
            tool,
            state: allowed ? "allowed" : "denied",
            detail: note,
          });
          if (!allowed) this.host.onDenied(run, tool);
          if (board) {
            // Close the board copy unless the owner's own answer already did.
            void this.host
              .closeQuestion(board, runId, `permission request ${allowed ? "allowed" : "denied"}: ${note}`)
              .catch(() => {});
          }
          resolve(allowed ? this.allowOf(input) : decision);
        },
      };
      entry.timer.unref?.();
      this.pending.set(id, entry);
      this.events.emit("changed", {});
    });
  }

  /**
   * The grants ledger changed — re-check every parked request against the new
   * patterns and allow the ones now covered. Wired to `grants.changed`.
   */
  async recheckGrants(): Promise<void> {
    if (!this.pending.size) return;
    if (await this.host.allowAll?.().catch(() => false)) {
      for (const [id] of [...this.pending]) {
        this.settleEntry(id, { behavior: "allow" }, "allowed — workspace allow-all enabled");
      }
      return;
    }
    const grants = await this.host.grantPatterns().catch(() => [] as string[]);
    for (const [id, entry] of [...this.pending]) {
      if (toolAllowedByPatterns(entry.tool, entry.input, [...entry.staticPatterns, ...grants])) {
        this.settleEntry(id, { behavior: "allow" }, "allowed via the workspace grants ledger");
      }
    }
  }

  /**
   * The board changed — read every parked request's question; an answer
   * starting with "allow" (case-insensitive) allows, anything else denies
   * with the owner's words. Wired to the orchestration change seam.
   */
  async onBoardChanged(): Promise<void> {
    for (const [id, entry] of [...this.pending]) {
      if (!entry.board) continue;
      const answer = await this.host.readAnswer(entry.board).catch(() => null);
      if (answer == null) continue;
      if (/^\s*allow/i.test(answer)) {
        this.settleEntry(id, { behavior: "allow" }, `owner answered: ${answer}`);
      } else {
        this.settleEntry(
          id,
          {
            behavior: "deny",
            message: `The owner declined this tool use ("${answer}"). Proceed another way or use ask_question.`,
          },
          `owner answered: ${answer}`,
        );
      }
    }
  }

  /** A run reached a terminal state — nothing can deliver an answer to it. */
  cancelForRun(runId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.runId !== runId) continue;
      this.settleEntry(
        id,
        { behavior: "deny", message: "The run ended before the permission request settled." },
        "run settled first",
      );
    }
  }

  /** Workspace close: deny everything parked so no HTTP request hangs. */
  dispose(): void {
    for (const [id] of [...this.pending]) {
      this.settleEntry(
        id,
        { behavior: "deny", message: "The workspace closed before the permission request settled." },
        "workspace closed",
      );
    }
  }

  private settleEntry(id: string, decision: PermissionDecision, note: string): void {
    const entry = this.pending.get(id);
    if (!entry) return; // claim-once: a later wake-up must not double-settle
    this.pending.delete(id);
    clearTimeout(entry.timer);
    try {
      entry.settle(decision, note, decision.behavior === "allow");
    } finally {
      // The pending projection changed even if a host-side note hook failed.
      this.events.emit("changed", {});
    }
  }

  private allowOf(input: unknown): PermissionDecision {
    return input && typeof input === "object" && !Array.isArray(input)
      ? { behavior: "allow", updatedInput: input as Record<string, unknown> }
      : { behavior: "allow" };
  }
}

/** One-line description of a tool call for questions and stream events. */
export function callSummary(tool: string, input: unknown): string {
  let detail: string | null = null;
  if (input && typeof input === "object") {
    for (const key of ["command", "file_path", "path", "url", "pattern", "query"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value) {
        detail = value;
        break;
      }
    }
  } else if (typeof input === "string") {
    detail = input;
  }
  if (detail && detail.length > 120) detail = `${detail.slice(0, 120)}…`;
  return detail ? `${tool} (${detail})` : tool;
}
