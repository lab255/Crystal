import { z } from "zod";
import { nowIso, uid } from "./ids.js";

/**
 * Agent orchestration model.
 *
 * Crystal executes agents by spawning the Claude Code CLI
 * (`claude -p <prompt> --output-format stream-json --verbose`) inside a repo.
 * The CLI emits newline-delimited JSON; `parseClaudeStreamLine` normalizes
 * those lines into Crystal's stable `AgentEvent` union so UIs never depend on
 * the CLI's wire format directly.
 */

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentIsolationSchema = z.enum(["none", "worktree"]);
export type AgentIsolation = z.infer<typeof AgentIsolationSchema>;

/**
 * A run's place in a manager/worker hierarchy. A "manager" run delegates by
 * dispatching "worker" runs (each pointing back via `parentRunId`); unset means
 * a standalone run that neither delegates nor was delegated.
 */
export const AGENT_ROLES = ["manager", "worker"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Why a run touched its task. Every kind of turn — implementation, code
 * review, security review, merging, CI gates, fixes, release — is attributed
 * to the owning task so cost rolls up across the task's whole lifecycle.
 */
export const RUN_PURPOSES = [
  "implement",
  "plan",
  "design",
  "manage",
  "code-review",
  "security-review",
  "merge",
  "ci",
  "fix",
  "release",
  "question",
  "index",
  "survey",
] as const;
export const RunPurposeSchema = z.enum(RUN_PURPOSES);
export type RunPurpose = z.infer<typeof RunPurposeSchema>;

/** Cumulative token/API usage across a run's turns. */
export const AgentUsageSchema = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  /** API calls observed (one per assistant turn). */
  apiCalls: z.number().default(0),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 0 };
}

export function usageTotalTokens(usage: AgentUsage | null | undefined): number {
  if (!usage) return 0;
  return (
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  );
}

const AGENT_TAG_PREFIX = "agent:";

/**
 * Dimensional tag carried by every run executed as a named agent profile —
 * stamped at run creation, so spend/attribution per profile falls out of the
 * existing tag index (`runsWithTag` + `rollupRunsUsage`), the same trick as
 * `workflow:<id>` and `program:<id>`.
 */
export function agentTag(agentId: string): string {
  return `${AGENT_TAG_PREFIX}${agentId}`;
}

/** True for tags minted by {@link agentTag} — the single prefix check. */
export function isAgentTag(tag: string): boolean {
  return tag.startsWith(AGENT_TAG_PREFIX);
}

export const AgentRunSchema = z.object({
  id: z.string(),
  /** Optional links back into the PM board. */
  taskId: z.string().nullish(),
  projectId: z.string().nullish(),
  /** Repo id from the workspace manifest the run executes in. */
  repoId: z.string().nullish(),
  /** Working directory relative to the workspace root. */
  cwd: z.string().default("."),
  /** "worktree" runs in a disposable git worktree instead of the repo itself. */
  isolation: AgentIsolationSchema.default("none"),
  /** Absolute host path of the run's worktree (null once cleaned up). */
  worktreePath: z.string().nullish(),
  /**
   * Git branch the run's worktree is checked out on (parallel workflow
   * tracks). Setting a branch implies worktree isolation.
   */
  branch: z.string().nullish(),
  prompt: z.string(),
  /** Agent profile that executed this run (see agent-profile.ts). */
  agentId: z.string().nullish(),
  /** Manager run that dispatched this worker, if any (see AgentRole). */
  parentRunId: z.string().nullish(),
  /**
   * Earlier run this one resumed (same Claude session, fresh run record).
   * Chains manager turns: the original manager plus every wake-up-on-worker
   * resume share one logical manager via this link (see chain helpers below).
   */
  resumedFromRunId: z.string().nullish(),
  /** Place in the manager/worker hierarchy (unset = standalone run). */
  role: AgentRoleSchema.nullish(),
  /** Why this run touched the task (see RUN_PURPOSES). */
  purpose: RunPurposeSchema.nullish(),
  /**
   * PTY terminal hosting this run when it is an *interactive* session (the
   * native Claude TUI in the terminal panel) rather than a headless `-p`
   * process. While the terminal is live, messages for the session (question
   * answers, steering) are typed into the PTY; once it exits, the chain is
   * resumable headlessly via the session id the terminal was launched with.
   */
  terminalId: z.string().nullish(),
  /** Workspace hosting the terminal when it is not this run's own host (hub managers). */
  terminalWs: z.string().nullish(),
  /** Dimensional tags for attribution (see tags.ts). */
  tags: z.array(z.string()).default([]),
  status: AgentRunStatusSchema.default("queued"),
  /** Claude Code session id (for --resume). */
  sessionId: z.string().nullish(),
  model: z.string().nullish(),
  /** Cumulative token/API usage across the run's turns. */
  usage: AgentUsageSchema.nullish(),
  costUsd: z.number().nullish(),
  turns: z.number().nullish(),
  durationMs: z.number().nullish(),
  /** Final result text (or error message on failure). */
  resultText: z.string().nullish(),
  /** Files the run edited (collected from Edit/Write tool calls), for review. */
  filesTouched: z.array(z.string()).default([]),
  createdAt: z.string(),
  startedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export function createAgentRun(init: {
  prompt: string;
  cwd?: string;
  taskId?: string | null;
  projectId?: string | null;
  repoId?: string | null;
  isolation?: AgentIsolation;
  branch?: string | null;
  agentId?: string | null;
  parentRunId?: string | null;
  resumedFromRunId?: string | null;
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
}): AgentRun {
  return AgentRunSchema.parse({
    id: uid("run"),
    prompt: init.prompt,
    cwd: init.cwd ?? ".",
    taskId: init.taskId ?? null,
    projectId: init.projectId ?? null,
    repoId: init.repoId ?? null,
    // A named branch needs a worktree to live in — branch implies isolation.
    isolation: init.branch ? "worktree" : (init.isolation ?? "none"),
    branch: init.branch ?? null,
    agentId: init.agentId ?? null,
    parentRunId: init.parentRunId ?? null,
    resumedFromRunId: init.resumedFromRunId ?? null,
    // A run with a parent is a worker by default; otherwise leave it unset
    // unless the caller declares it a manager.
    role: init.role ?? (init.parentRunId ? "worker" : null),
    purpose: init.purpose ?? null,
    // Profile attribution is stamped here, not per call site, so every path
    // that creates a run (start, interactive, workers, resumed chain turns)
    // carries the `agent:<id>` tag without each caller remembering to.
    tags: init.agentId
      ? [...new Set([...(init.tags ?? []), agentTag(init.agentId)])]
      : (init.tags ?? []),
    createdAt: nowIso(),
  });
}

/**
 * Root of a run's resume chain: the original run that later turns of the same
 * logical session were resumed from. Runs form chains via `resumedFromRunId`
 * (a manager woken on worker settlement is a fresh run record, same manager).
 */
export function chainRootId(runId: string, runsById: Map<string, AgentRun>): string {
  let id = runId;
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const prev = runsById.get(id)?.resumedFromRunId;
    if (!prev) break;
    id = prev;
  }
  return id;
}

/** Workspace file path from an Edit/Write-style tool call, or null. */
export function touchedFileFromToolUse(name: string, input: unknown): string | null {
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return null;
  const p = (input as { file_path?: unknown; notebook_path?: unknown } | null | undefined) ?? {};
  const file = typeof p.file_path === "string" ? p.file_path : p.notebook_path;
  return typeof file === "string" && file ? file : null;
}

/** Every run attributed to a task, whatever its purpose (implement, review, merge, CI, …). */
export function runsForTask(taskId: string, runs: AgentRun[]): AgentRun[] {
  return runs.filter((r) => r.taskId === taskId);
}

/** A logical session (its resume chain collapsed) with its worker sessions beneath it. */
export interface RunNode {
  /** The chain's face: its latest turn. */
  run: AgentRun;
  /** Every turn of the chain, oldest first (length 1 = never resumed). */
  turns: AgentRun[];
  /** Worker sessions dispatched by any turn of this chain, oldest first. */
  workers: RunNode[];
}

/**
 * Fold a flat run list into a session forest for display. Two collapses
 * happen at once:
 *
 * - **Resume chains collapse to one node.** Every `deliver`/wake-up resume
 *   mints a fresh run record for the *same* logical Claude session
 *   (`resumedFromRunId` links, `sessionId` as corroborating evidence for
 *   console turns that carry only the session). Listing each turn as its own
 *   row made a steered agent look like a brand-new one — one conversation,
 *   one row. The node's face is the latest turn; older turns stay reachable
 *   through `turns` (the surface's turn strip).
 * - **Workers nest under their manager's session**, whichever turn of the
 *   manager dispatched them. Orphaned workers (parent absent from the list)
 *   fall back to roots so nothing is ever hidden.
 *
 * Root order follows the input (the store hands runs back newest-first) by
 * each session's newest turn, so a freshly resumed session keeps its slot.
 */
export function groupRunsByManager(runs: AgentRun[]): RunNode[] {
  const byId = new Map(runs.map((r) => [r.id, r]));

  // 1. Chain membership: resume-link roots, then merge chains sharing a
  // sessionId (an agent-console turn resumes by session with no run link).
  const chainKeyOf = new Map<string, string>();
  const bySession = new Map<string, string>();
  const alias = new Map<string, string>(); // chain key -> canonical key
  const canon = (key: string): string => {
    let k = key;
    while (alias.has(k)) k = alias.get(k)!;
    return k;
  };
  for (const r of runs) {
    const key = canon(chainRootId(r.id, byId));
    chainKeyOf.set(r.id, key);
    if (!r.sessionId) continue;
    const prior = bySession.get(r.sessionId);
    if (prior === undefined) bySession.set(r.sessionId, key);
    else if (canon(prior) !== key) alias.set(key, canon(prior));
  }

  const chains = new Map<string, AgentRun[]>();
  for (const r of runs) {
    const key = canon(chainKeyOf.get(r.id)!);
    const list = chains.get(key);
    if (list) list.push(r);
    else chains.set(key, [r]);
  }

  const nodeOf = new Map<string, RunNode>();
  const faceKeyOfRunId = new Map<string, string>();
  for (const [key, turns] of chains) {
    turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    nodeOf.set(key, { run: turns[turns.length - 1]!, turns, workers: [] });
    for (const t of turns) faceKeyOfRunId.set(t.id, key);
  }

  // 2. Manager→worker nesting between sessions. A chain is a worker chain if
  // any of its turns was dispatched by a run in the list (the dispatch link
  // lives on the original worker run; resumed worker turns carry no parent).
  const childKeys = new Set<string>();
  for (const [key, node] of nodeOf) {
    const parentRunId = node.turns.find((t) => t.parentRunId)?.parentRunId;
    const parentKey = parentRunId ? faceKeyOfRunId.get(parentRunId) : undefined;
    if (parentKey === undefined || parentKey === key) continue;
    nodeOf.get(parentKey)!.workers.push(node);
    childKeys.add(key);
  }

  const nodes: RunNode[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    const key = faceKeyOfRunId.get(r.id)!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (childKeys.has(key)) continue; // rendered under its manager
    const node = nodeOf.get(key)!;
    node.workers.sort(
      (a, b) => a.turns[0]!.createdAt.localeCompare(b.turns[0]!.createdAt),
    );
    nodes.push(node);
  }
  return nodes;
}

/**
 * Cumulative usage/cost across a set of runs — a task's token cost is the sum
 * of every turn that touched it. `activeMs` sums CLI-reported run durations;
 * pre-usage-tracking runs contribute their `turns` count as API calls.
 */
export function rollupRunsUsage(runs: AgentRun[]): {
  usage: AgentUsage;
  costUsd: number;
  activeMs: number;
  runCount: number;
} {
  const usage = emptyUsage();
  let costUsd = 0;
  let activeMs = 0;
  for (const run of runs) {
    if (run.usage) {
      usage.inputTokens += run.usage.inputTokens;
      usage.outputTokens += run.usage.outputTokens;
      usage.cacheReadTokens += run.usage.cacheReadTokens;
      usage.cacheCreationTokens += run.usage.cacheCreationTokens;
      usage.apiCalls += run.usage.apiCalls;
    } else if (run.turns != null) {
      usage.apiCalls += run.turns;
    }
    if (run.costUsd != null) costUsd += run.costUsd;
    if (run.durationMs != null) activeMs += run.durationMs;
  }
  return { usage, costUsd, activeMs, runCount: runs.length };
}

/** API call rate in calls/minute over active run time (null when unknowable). */
export function apiRatePerMin(usage: AgentUsage, activeMs: number): number | null {
  if (activeMs <= 0 || usage.apiCalls === 0) return null;
  return usage.apiCalls / (activeMs / 60_000);
}

/* ------------------------------------------------------------------ */
/* Normalized event stream                                             */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: "init"; sessionId: string; model: string; cwd: string; tools: string[] }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      type: "result";
      ok: boolean;
      resultText: string;
      costUsd: number | null;
      turns: number | null;
      durationMs: number | null;
      sessionId: string | null;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { type: "question"; text: string }
  | { type: "dispatch"; spec: WorkerSpec }
  | { type: "stderr"; text: string }
  | { type: "status"; status: AgentRunStatus; message?: string }
  | { type: "unknown"; raw: unknown };

/**
 * Line prefix an agent prints to request user input mid-task. The parser
 * turns marked lines into `question` events; the board surfaces them as async
 * questions for the task's human owner, whose answer resumes the session.
 */
export const QUESTION_MARKER = "CRYSTAL_QUESTION:";

/** Question texts marked with QUESTION_MARKER in a block of agent output. */
export function extractQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(QUESTION_MARKER))
    .map((line) => line.slice(QUESTION_MARKER.length).trim())
    .filter(Boolean);
}

/**
 * The `~/.claude/projects/<dir>` name Claude Code files a cwd's session
 * transcripts under: every non-alphanumeric character becomes a dash
 * (`C:\Users\Eliot Lim\ws` → `C--Users-Eliot-Lim-ws`).
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Sum token usage out of a Claude Code session transcript
 * (`~/.claude/projects/<dir>/<sessionId>.jsonl`). Interactive terminal runs
 * emit no stream-json, so their bill is harvested from the transcript once
 * the session ends. One assistant message id spans several transcript lines
 * (thinking chunk, text chunk, tool-use chunk) — the last usage-bearing line
 * per id wins, and each id counts as one API call.
 */
export function transcriptUsage(jsonl: string): { usage: AgentUsage; model: string | null } {
  const byId = new Map<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
  >();
  let model: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        message?: {
          id?: unknown;
          role?: unknown;
          model?: unknown;
          usage?: Record<string, number> | null;
        };
      };
      const m = entry?.message;
      if (m?.role !== "assistant" || !m.usage || typeof m.id !== "string") continue;
      if (typeof m.model === "string" && m.model) model = m.model;
      byId.set(m.id, m.usage);
    } catch {
      // A truncated trailing line (session still flushing) is not an error.
    }
  }
  const usage = emptyUsage();
  for (const u of byId.values()) {
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    usage.apiCalls += 1;
  }
  return { usage, model };
}

/** What a manager run asks for when it delegates a unit of work to a worker. */
export const WorkerSpecSchema = z.object({
  /** The worker's task prompt (its first line doubles as the run headline). */
  prompt: z.string().min(1),
  /** Working directory relative to the workspace root (defaults to the manager's). */
  cwd: z.string().nullish(),
  /** Run the worker in a disposable git worktree (defaults to "none"). */
  isolation: AgentIsolationSchema.nullish(),
  /**
   * Git branch to check the worker's worktree out on (created at HEAD when it
   * doesn't exist). Implies worktree isolation — parallel workflow tracks
   * each develop on their own branch.
   */
  branch: z.string().nullish(),
  /**
   * Claude model alias/id for the worker (`--model`). Route by intensity:
   * heavyweight models for code-intensive work (develop, merge), lighter
   * ones for plan/design/review-style tasks. Omitted = CLI default.
   */
  model: z.string().nullish(),
  /**
   * Agent profile to run the worker as (see agent-profile.ts). The server
   * resolves it to model/skills/tool policy; an explicit `model` in this spec
   * wins over the profile's.
   */
  agentId: z.string().nullish(),
  /** Why this worker touches the task (defaults to the manager's purpose). */
  purpose: RunPurposeSchema.nullish(),
  /**
   * Board task the worker's cost and history attribute to (defaults to the
   * manager's own task). A manager driving several tasks must set this, or
   * every worker bills the manager's task.
   */
  taskId: z.string().nullish(),
  /** Dimensional tags stamped onto the worker run. */
  tags: z.array(z.string()).nullish(),
});
export type WorkerSpec = z.infer<typeof WorkerSpecSchema>;

/**
 * Line prefix a *manager* run prints to dispatch a worker: `CRYSTAL_DISPATCH:`
 * followed by a JSON {@link WorkerSpec}. The parser turns each marked line into
 * a `dispatch` event; the server spawns a worker run parented to the manager.
 * This is the CLI-native path — a manager without the MCP `dispatch_worker`
 * tool can still fan out into tracked worker runs.
 */
export const DISPATCH_MARKER = "CRYSTAL_DISPATCH:";

/**
 * Worker specs marked with DISPATCH_MARKER in a block of agent output.
 * Malformed JSON or promptless specs are dropped so stray output can never
 * spawn a junk run or crash the manager.
 */
export function extractDispatches(text: string): WorkerSpec[] {
  const specs: WorkerSpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line.startsWith(DISPATCH_MARKER)) continue;
    const json = line.slice(DISPATCH_MARKER.length).trim();
    if (!json) continue;
    try {
      const parsed = WorkerSpecSchema.safeParse(JSON.parse(json));
      if (parsed.success) specs.push(parsed.data);
    } catch {
      // Ignore malformed dispatch lines — a manager can't break its run.
    }
  }
  return specs;
}

/** An event as broadcast by the server: sequenced within a run. */
export interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  event: AgentEvent;
}

/* ------------------------------------------------------------------ */
/* Claude Code stream-json parsing                                     */
/* ------------------------------------------------------------------ */

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Flatten a tool_result `content` value (string or content-block array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? asString((block as { text?: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * Parse one NDJSON line from `claude --output-format stream-json` into zero or
 * more normalized events. Unknown shapes come back as `{type:"unknown"}` so
 * the pipeline is forward-compatible with CLI changes; unparseable lines are
 * surfaced as stderr-style noise rather than thrown.
 */
export function parseClaudeStreamLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ type: "stderr", text: trimmed }];
  }
  if (!msg || typeof msg !== "object") return [{ type: "unknown", raw: msg }];
  const m = msg as Record<string, unknown>;

  switch (m.type) {
    case "system": {
      if (m.subtype === "init") {
        return [
          {
            type: "init",
            sessionId: asString(m.session_id),
            model: asString(m.model),
            cwd: asString(m.cwd),
            tools: Array.isArray(m.tools) ? m.tools.map((t) => asString(t)) : [],
          },
        ];
      }
      return [{ type: "unknown", raw: m }];
    }

    case "assistant":
    case "user": {
      const message = m.message as Record<string, unknown> | undefined;
      const isAssistant = m.type === "assistant";
      const events: AgentEvent[] = [];
      // Each assistant message is one API call; its usage block is the turn's
      // token bill, accumulated per run for task-level cost attribution.
      const usage =
        isAssistant && message?.usage && typeof message.usage === "object"
          ? (message.usage as Record<string, unknown>)
          : null;
      if (usage) {
        events.push({
          type: "usage",
          inputTokens: asNumber(usage.input_tokens) ?? 0,
          outputTokens: asNumber(usage.output_tokens) ?? 0,
          cacheReadTokens: asNumber(usage.cache_read_input_tokens) ?? 0,
          cacheCreationTokens: asNumber(usage.cache_creation_input_tokens) ?? 0,
        });
      }
      const pushText = (text: string) => {
        events.push({ type: "text", text });
        if (!isAssistant) return;
        for (const question of extractQuestions(text)) {
          events.push({ type: "question", text: question });
        }
        for (const spec of extractDispatches(text)) {
          events.push({ type: "dispatch", spec });
        }
      };
      const content = message?.content;
      if (typeof content === "string") {
        if (content) pushText(content);
        return events;
      }
      if (!Array.isArray(content)) return events;
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        switch (block.type) {
          case "text": {
            const text = asString(block.text);
            if (text) pushText(text);
            break;
          }
          case "thinking": {
            const text = asString(block.thinking);
            if (text) events.push({ type: "thinking", text });
            break;
          }
          case "tool_use":
            events.push({
              type: "tool_use",
              toolUseId: asString(block.id),
              name: asString(block.name),
              input: block.input,
            });
            break;
          case "tool_result":
            events.push({
              type: "tool_result",
              toolUseId: asString(block.tool_use_id),
              content: toolResultText(block.content),
              isError: block.is_error === true,
            });
            break;
          default:
            break;
        }
      }
      return events;
    }

    case "result": {
      const ok = m.is_error !== true && m.subtype === "success";
      return [
        {
          type: "result",
          ok,
          resultText: asString(m.result, ok ? "" : asString(m.subtype)),
          costUsd: asNumber(m.total_cost_usd),
          turns: asNumber(m.num_turns),
          durationMs: asNumber(m.duration_ms),
          sessionId: typeof m.session_id === "string" ? m.session_id : null,
        },
      ];
    }

    // Partial streaming deltas (--include-partial-messages); ignored — full
    // messages arrive as `assistant` lines.
    case "stream_event":
      return [];

    default:
      return [{ type: "unknown", raw: m }];
  }
}

/** Accumulates raw chunks and yields complete lines (handles \r\n and split chunks). */
export class LineBuffer {
  private buf = "";

  constructor(
    /**
     * Flush the pending partial line once it exceeds this many characters —
     * bounds memory against a pathological never-ending line (the consumer
     * sees the oversized fragment as one line; stream parsers record it as
     * noise). Default: unlimited.
     */
    private readonly maxBuffered = Infinity,
  ) {}

  push(chunk: string): string[] {
    // Fast path: no newline means pure append — re-splitting the whole
    // accumulated buffer per chunk would be quadratic on one long line.
    if (!chunk.includes("\n")) {
      this.buf += chunk;
      if (this.buf.length > this.maxBuffered) {
        const flushed = this.buf;
        this.buf = "";
        return [flushed];
      }
      return [];
    }
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? "";
    return lines.filter((l) => l.length > 0);
  }

  /** Flush any trailing partial line (call at stream end). */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}
