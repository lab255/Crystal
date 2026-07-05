import { describe, expect, it } from "vitest";
import { LineBuffer, parseClaudeStreamLine } from "./agent.js";

describe("parseClaudeStreamLine", () => {
  it("parses system init", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-5",
      cwd: "C:\\repo",
      tools: ["Bash", "Read"],
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "init", sessionId: "sess-1", model: "claude-sonnet-5", cwd: "C:\\repo", tools: ["Bash", "Read"] },
    ]);
  });

  it("parses assistant text + tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool_use", toolUseId: "tu_1", name: "Read", input: { file_path: "a.ts" } },
    ]);
  });

  it("parses tool results from user messages, flattening block arrays", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [{ type: "text", text: "file contents" }],
            is_error: false,
          },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "tool_result", toolUseId: "tu_1", content: "file contents", isError: false },
    ]);
  });

  it("parses success and error results", () => {
    const ok = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      total_cost_usd: 0.12,
      num_turns: 4,
      duration_ms: 8000,
      session_id: "sess-1",
    });
    expect(parseClaudeStreamLine(ok)).toEqual([
      {
        type: "result",
        ok: true,
        resultText: "Done.",
        costUsd: 0.12,
        turns: 4,
        durationMs: 8000,
        sessionId: "sess-1",
      },
    ]);

    const err = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true });
    const [evt] = parseClaudeStreamLine(err);
    expect(evt).toMatchObject({ type: "result", ok: false, resultText: "error_max_turns" });
  });

  it("treats non-JSON lines as stderr noise and unknown types as unknown", () => {
    expect(parseClaudeStreamLine("warning: something")).toEqual([
      { type: "stderr", text: "warning: something" },
    ]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "mystery" }))).toEqual([
      { type: "unknown", raw: { type: "mystery" } },
    ]);
    expect(parseClaudeStreamLine("   ")).toEqual([]);
  });

  it("ignores partial stream_event deltas", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "stream_event", event: {} }))).toEqual([]);
  });
});

describe("LineBuffer", () => {
  it("reassembles lines across chunk boundaries", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push('1}\n{"b":2}\r\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(buf.push(":3}")).toEqual([]);
    expect(buf.flush()).toEqual(['{"c":3}']);
    expect(buf.flush()).toEqual([]);
  });
});
