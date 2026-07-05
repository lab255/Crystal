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
  prompt: z.string(),
  status: AgentRunStatusSchema.default("queued"),
  /** Claude Code session id (for --resume). */
  sessionId: z.string().nullish(),
  model: z.string().nullish(),
  costUsd: z.number().nullish(),
  turns: z.number().nullish(),
  durationMs: z.number().nullish(),
  /** Final result text (or error message on failure). */
  resultText: z.string().nullish(),
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
}): AgentRun {
  return AgentRunSchema.parse({
    id: uid("run"),
    prompt: init.prompt,
    cwd: init.cwd ?? ".",
    taskId: init.taskId ?? null,
    projectId: init.projectId ?? null,
    repoId: init.repoId ?? null,
    isolation: init.isolation ?? "none",
    createdAt: nowIso(),
  });
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
  | { type: "stderr"; text: string }
  | { type: "status"; status: AgentRunStatus; message?: string }
  | { type: "unknown"; raw: unknown };

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
      const content = message?.content;
      if (typeof content === "string") {
        return content ? [{ type: "text", text: content }] : [];
      }
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        switch (block.type) {
          case "text": {
            const text = asString(block.text);
            if (text) events.push({ type: "text", text });
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

  push(chunk: string): string[] {
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
