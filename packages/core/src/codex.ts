import {
  extractDispatches,
  extractQuestions,
  type AgentEvent,
} from "./agent.js";

/**
 * OpenAI Codex CLI stream normalization.
 *
 * `codex exec --json` emits newline-delimited JSON *thread events*:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.updated"|"item.completed","item":{…}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…}}
 *   {"type":"turn.failed","error":{"message":"…"}}
 *   {"type":"error","message":"…"}
 *
 * Items carry the actual activity — `agent_message`, `reasoning`,
 * `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
 * `todo_list`, `error` (the item-kind key is `type` in current CLIs,
 * `item_type` in some older builds; both are accepted).
 *
 * This parser folds that vocabulary into Crystal's `AgentEvent` union so the
 * whole pipeline downstream (run records, transcripts, cost rollups, cost
 * caps) is provider-agnostic. It is *stateful* — unlike the Claude stream,
 * Codex has no terminal `result` line, so the parser remembers the thread id,
 * the last agent message and the turn count and synthesizes Crystal's
 * `result` event at each `turn.completed`/`turn.failed`. One instance per
 * process/run; never share across runs.
 *
 * Unknown event or item kinds degrade to stderr-style info lines — a CLI
 * upgrade must never throw inside the stream pump.
 */

/** codex reports no dollar figure — costUsd stays null; estimation covers it. */
interface CodexUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export class CodexStreamParser {
  private threadId: string | null = null;
  private lastMessage = "";
  private turns = 0;

  /** Parse one stdout line into zero or more normalized events. */
  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // codex prints human-readable preamble/noise outside --json sometimes;
      // surface it, never throw.
      return [{ type: "stderr", text: trimmed }];
    }
    if (!msg || typeof msg !== "object") return [{ type: "unknown", raw: msg }];
    const m = msg as Record<string, unknown>;

    switch (m.type) {
      case "thread.started": {
        this.threadId = asString(m.thread_id) || null;
        return [
          {
            type: "init",
            // The thread id is the session id: `codex exec resume <id>`.
            sessionId: asString(m.thread_id),
            // Codex does not name the model here — the consumer keeps the
            // dispatched model (record() treats "" as "no information").
            model: asString(m.model),
            cwd: asString(m.cwd),
            tools: [],
          },
        ];
      }

      case "turn.started":
      case "item.started":
      case "item.updated":
        // Completed items carry the whole payload; deltas are redundant.
        return [];

      case "item.completed":
        return this.itemEvents(m.item);

      case "turn.completed": {
        this.turns += 1;
        const usage = (m.usage ?? {}) as CodexUsage;
        const input = asCount(usage.input_tokens);
        const cached = asCount(usage.cached_input_tokens);
        return [
          {
            type: "usage",
            // cached_input_tokens is a subset of input_tokens — split them so
            // the cache-read discount applies instead of double-billing.
            inputTokens: Math.max(0, input - cached),
            outputTokens: asCount(usage.output_tokens),
            cacheReadTokens: cached,
            cacheCreationTokens: 0,
          },
          this.resultEvent(true, this.lastMessage),
        ];
      }

      case "turn.failed": {
        this.turns += 1;
        const error = (m.error ?? {}) as { message?: unknown };
        return [
          this.resultEvent(
            false,
            asString(error.message) || this.lastMessage || "codex turn failed",
          ),
        ];
      }

      case "error":
        return [{ type: "stderr", text: asString(m.message, trimmed) }];

      default:
        // Forward-compat: a new event kind is information, not a crash.
        return [{ type: "stderr", text: `[codex] ${trimmed}` }];
    }
  }

  private resultEvent(ok: boolean, resultText: string): AgentEvent {
    return {
      type: "result",
      ok,
      resultText,
      costUsd: null, // codex reports tokens, never dollars — estimation path
      turns: this.turns,
      durationMs: null,
      sessionId: this.threadId,
    };
  }

  private itemEvents(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== "object") return [{ type: "unknown", raw }];
    const item = raw as Record<string, unknown>;
    const kind = asString(item.type) || asString(item.item_type);
    const id = asString(item.id, "codex-item");

    switch (kind) {
      case "agent_message":
      case "assistant_message": {
        const text = asString(item.text);
        if (!text) return [];
        this.lastMessage = text;
        const events: AgentEvent[] = [{ type: "text", text }];
        // The CRYSTAL_QUESTION / CRYSTAL_DISPATCH line protocols are
        // provider-agnostic — a codex run files board questions the same way.
        for (const question of extractQuestions(text)) {
          events.push({ type: "question", text: question });
        }
        for (const spec of extractDispatches(text)) {
          events.push({ type: "dispatch", spec });
        }
        return events;
      }

      case "reasoning": {
        const text = asString(item.text);
        return text ? [{ type: "thinking", text }] : [];
      }

      case "command_execution": {
        const exit = item.exit_code;
        const failed =
          item.status === "failed" || (typeof exit === "number" && exit !== 0);
        return [
          {
            type: "tool_use",
            toolUseId: id,
            name: "Bash",
            input: { command: asString(item.command) },
          },
          {
            type: "tool_result",
            toolUseId: id,
            content: asString(item.aggregated_output),
            isError: failed,
          },
        ];
      }

      case "file_change": {
        // One synthetic Edit/Write per changed path so the shared
        // filesTouched harvesting (touchedFileFromToolUse) sees codex edits.
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const events: AgentEvent[] = [];
        changes.forEach((change, i) => {
          if (!change || typeof change !== "object") return;
          const c = change as Record<string, unknown>;
          const file = asString(c.path);
          if (!file) return;
          events.push({
            type: "tool_use",
            toolUseId: `${id}:${i}`,
            name: c.kind === "add" ? "Write" : "Edit",
            input: { file_path: file },
          });
        });
        return events;
      }

      case "mcp_tool_call": {
        const name = [asString(item.server), asString(item.tool)]
          .filter(Boolean)
          .join("__");
        return [
          {
            type: "tool_use",
            toolUseId: id,
            name: name ? `mcp__${name}` : "mcp",
            input: item.arguments ?? {},
          },
        ];
      }

      case "web_search":
        return [
          {
            type: "tool_use",
            toolUseId: id,
            name: "WebSearch",
            input: { query: asString(item.query) },
          },
        ];

      case "todo_list":
        // Plan-state bookkeeping — no Crystal counterpart worth the noise.
        return [];

      case "error":
        return [{ type: "stderr", text: asString(item.message, "codex item error") }];

      default:
        return [{ type: "stderr", text: `[codex] unhandled item: ${kind || "(untyped)"}` }];
    }
  }
}
