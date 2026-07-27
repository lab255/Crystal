import type { AgentEvent, TerminalStream } from "@crystal/core";

/**
 * The "compact density" model of an agent transcript: each event flattened to
 * at most one terminal-style line. Shared by the terminal panel's agent
 * consoles (which append these into their chunk buffers) and RunTranscript's
 * compact mode — one flattening, two renderers.
 */

const AGENT_PREVIEW_KEYS = ["command", "file_path", "path", "pattern", "url", "prompt"] as const;

/** One rendered chunk of the flattened transcript. */
export interface AgentEventChunk {
  stream: TerminalStream;
  text: string;
}

/** One-line transcript rendering of an agent event (null = don't show). */
export function agentEventToChunk(event: AgentEvent): AgentEventChunk | null {
  switch (event.type) {
    case "text":
      return { stream: "stdout", text: event.text.endsWith("\n") ? event.text : `${event.text}\n` };
    case "tool_use": {
      let detail = "";
      if (event.input && typeof event.input === "object") {
        for (const key of AGENT_PREVIEW_KEYS) {
          const value = (event.input as Record<string, unknown>)[key];
          if (typeof value === "string" && value) {
            detail = value.length > 120 ? `${value.slice(0, 120)}…` : value;
            break;
          }
        }
      }
      return { stream: "system", text: `▸ ${event.name}${detail ? ` ${detail}` : ""}\n` };
    }
    case "tool_result":
      return event.isError ? { stream: "stderr", text: `${event.content}\n` } : null;
    case "stderr":
      return { stream: "stderr", text: `${event.text}\n` };
    case "result": {
      if (!event.ok) return { stream: "stderr", text: `✖ ${event.resultText || "run failed"}\n` };
      const cost = event.costUsd != null ? ` · $${event.costUsd.toFixed(2)}` : "";
      const turns = event.turns != null ? ` · ${event.turns} turns` : "";
      return { stream: "system", text: `✔ done${cost}${turns}\n` };
    }
    case "status":
      return event.message ? { stream: "system", text: `${event.message}\n` } : null;
    case "question":
      return { stream: "system", text: `? ${event.text} (answer from the task on the board)\n` };
    case "dispatch":
      return { stream: "system", text: `⑂ dispatch worker: ${event.spec.prompt.split("\n")[0]}\n` };
    case "init":
    case "thinking":
    case "usage":
    case "unknown":
      return null;
  }
}
