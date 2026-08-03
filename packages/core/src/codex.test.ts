import { describe, expect, it } from "vitest";
import { CodexStreamParser } from "./codex.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("CodexStreamParser", () => {
  it("maps thread.started to init with the thread id as session id", () => {
    const p = new CodexStreamParser();
    const events = p.push(line({ type: "thread.started", thread_id: "th_1" }));
    expect(events).toEqual([
      { type: "init", sessionId: "th_1", model: "", cwd: "", tools: [] },
    ]);
  });

  it("emits text for agent messages and extracts the question line protocol", () => {
    const p = new CodexStreamParser();
    const events = p.push(
      line({
        type: "item.completed",
        item: { type: "agent_message", id: "i1", text: "CRYSTAL_QUESTION: ship it?" },
      }),
    );
    expect(events[0]).toEqual({ type: "text", text: "CRYSTAL_QUESTION: ship it?" });
    expect(events.some((e) => e.type === "question")).toBe(true);
  });

  it("normalizes command executions into tool_use/tool_result pairs", () => {
    const p = new CodexStreamParser();
    const events = p.push(
      line({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "c1",
          command: "pnpm test",
          aggregated_output: "1 passed",
          exit_code: 0,
        },
      }),
    );
    expect(events).toEqual([
      { type: "tool_use", toolUseId: "c1", name: "Bash", input: { command: "pnpm test" } },
      { type: "tool_result", toolUseId: "c1", content: "1 passed", isError: false },
    ]);
  });

  it("splits cached input out of usage and synthesizes a result at turn.completed", () => {
    const p = new CodexStreamParser();
    p.push(line({ type: "thread.started", thread_id: "th_2" }));
    p.push(
      line({
        type: "item.completed",
        item: { type: "agent_message", id: "m", text: "done." },
      }),
    );
    const events = p.push(
      line({
        type: "turn.completed",
        usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
      }),
    );
    expect(events[0]).toEqual({
      type: "usage",
      inputTokens: 400,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheCreationTokens: 0,
    });
    expect(events[1]).toMatchObject({
      type: "result",
      ok: true,
      resultText: "done.",
      sessionId: "th_2",
      turns: 1,
    });
  });

  it("synthesizes a failed result from turn.failed", () => {
    const p = new CodexStreamParser();
    const events = p.push(line({ type: "turn.failed", error: { message: "boom" } }));
    expect(events[0]).toMatchObject({ type: "result", ok: false, resultText: "boom" });
  });

  it("degrades non-JSON noise and unknown kinds to stderr, never throws", () => {
    const p = new CodexStreamParser();
    expect(p.push("codex v0.30 booting…")).toEqual([
      { type: "stderr", text: "codex v0.30 booting…" },
    ]);
    expect(p.push(line({ type: "shiny.new.event" }))[0]!.type).toBe("stderr");
    expect(
      p.push(line({ type: "item.completed", item: { type: "hologram", id: "x" } }))[0]!.type,
    ).toBe("stderr");
  });
});
