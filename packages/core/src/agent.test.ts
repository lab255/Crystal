import { describe, expect, it } from "vitest";
import {
  LineBuffer,
  QUESTION_MARKER,
  apiRatePerMin,
  claudeProjectDirName,
  createAgentRun,
  extractDispatches,
  extractQuestions,
  groupRunsByManager,
  parseClaudeStreamLine,
  rollupRunsUsage,
  transcriptUsage,
  usageTotalTokens,
  type AgentRun,
} from "./agent.js";

describe("claudeProjectDirName", () => {
  it("mirrors Claude Code's munging: every non-alphanumeric becomes a dash", () => {
    expect(claudeProjectDirName("C:\\Users\\Eliot Lim\\Workspaces\\crystal")).toBe(
      "C--Users-Eliot-Lim-Workspaces-crystal",
    );
    expect(claudeProjectDirName("/home/dev/.crystal/worktrees/run_1")).toBe(
      "-home-dev--crystal-worktrees-run-1",
    );
  });
});

describe("transcriptUsage", () => {
  const line = (id: string, usage: Record<string, number>, model = "claude-sonnet-5") =>
    JSON.stringify({ message: { id, role: "assistant", model, usage } });

  it("sums per message id — chunked lines of one message count once", () => {
    // One assistant message spans several transcript lines (thinking chunk,
    // then text chunk); the last usage-bearing line per id wins.
    const jsonl = [
      line("msg_1", { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100 }),
      line("msg_1", { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200 }),
      line("msg_2", { input_tokens: 3, output_tokens: 30, cache_creation_input_tokens: 500 }),
      JSON.stringify({ type: "mode", mode: "normal" }), // non-message lines skipped
      '{"truncated": ', // a mid-flush partial line is not an error
    ].join("\n");
    const { usage, model } = transcriptUsage(jsonl);
    expect(usage.apiCalls).toBe(2);
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(200);
    expect(usage.cacheCreationTokens).toBe(500);
    expect(model).toBe("claude-sonnet-5");
  });

  it("reads an empty or foreign file as zero usage", () => {
    expect(transcriptUsage("").usage.apiCalls).toBe(0);
    expect(transcriptUsage('{"message":{"role":"user"}}').usage.apiCalls).toBe(0);
  });
});

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

  it("extracts per-turn usage from assistant messages (one API call each)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 560,
          cache_creation_input_tokens: 78,
        },
        content: [{ type: "text", text: "Working on it." }],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      {
        type: "usage",
        inputTokens: 12,
        outputTokens: 34,
        cacheReadTokens: 560,
        cacheCreationTokens: 78,
      },
      { type: "text", text: "Working on it." },
    ]);
    // user messages (tool results) never bill usage
    const userLine = JSON.stringify({
      type: "user",
      message: { usage: { input_tokens: 5 }, content: "ignored" },
    });
    expect(parseClaudeStreamLine(userLine)).toEqual([{ type: "text", text: "ignored" }]);
  });

  it("turns marked assistant lines into question events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: `I checked both options.\n${QUESTION_MARKER} Should the API stay backwards compatible?`,
          },
        ],
      },
    });
    const events = parseClaudeStreamLine(line);
    expect(events).toContainEqual({
      type: "question",
      text: "Should the API stay backwards compatible?",
    });
    // The marker only speaks for the agent — user/tool text never raises one.
    const echoed = JSON.stringify({
      type: "user",
      message: { content: `${QUESTION_MARKER} echoed back` },
    });
    expect(parseClaudeStreamLine(echoed).some((e) => e.type === "question")).toBe(false);
  });
});

describe("extractQuestions", () => {
  it("finds marked lines and ignores everything else", () => {
    const text = [
      "Some progress notes.",
      `${QUESTION_MARKER} Keep the old endpoint?`,
      `  ${QUESTION_MARKER} Second question `,
      `${QUESTION_MARKER}`,
      "no marker here",
    ].join("\n");
    expect(extractQuestions(text)).toEqual(["Keep the old endpoint?", "Second question"]);
  });
});

describe("usage rollups", () => {
  const run = (patch: Partial<AgentRun>): AgentRun => ({
    ...createAgentRun({ prompt: "x" }),
    ...patch,
  });

  it("sums every run touching a task, whatever its purpose", () => {
    const runs = [
      run({
        purpose: "implement",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, apiCalls: 3 },
        costUsd: 0.5,
        durationMs: 60_000,
      }),
      run({
        purpose: "code-review",
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, apiCalls: 1 },
        costUsd: 0.1,
        durationMs: 30_000,
      }),
      // Legacy run recorded before usage tracking: turns count as API calls.
      run({ purpose: "merge", turns: 2, costUsd: 0.05 }),
    ];
    const rollup = rollupRunsUsage(runs);
    expect(rollup.usage).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      apiCalls: 6,
    });
    expect(rollup.costUsd).toBeCloseTo(0.65);
    expect(rollup.activeMs).toBe(90_000);
    expect(rollup.runCount).toBe(3);
    expect(usageTotalTokens(rollup.usage)).toBe(195);
    // 6 calls over 1.5 active minutes
    expect(apiRatePerMin(rollup.usage, rollup.activeMs)).toBeCloseTo(4);
  });

  it("reports no rate when nothing ran", () => {
    const rollup = rollupRunsUsage([]);
    expect(apiRatePerMin(rollup.usage, rollup.activeMs)).toBeNull();
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

  it("handles \\r\\n split across the newline-less fast path", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\r')).toEqual([]);
    expect(buf.push("\n")).toEqual(['{"a":1}']);
  });

  it("flushes a pathological never-ending line at the cap", () => {
    const buf = new LineBuffer(10);
    expect(buf.push("12345")).toEqual([]);
    expect(buf.push("123456")).toEqual(["12345123456"]); // over cap → flushed as-is
    expect(buf.push("ok\n")).toEqual(["ok"]); // framing recovers afterwards
  });
});

describe("extractDispatches", () => {
  it("parses valid dispatch markers and drops malformed / promptless ones", () => {
    const text = [
      "Delegating the pieces now.",
      'CRYSTAL_DISPATCH: {"prompt": "write the parser", "isolation": "worktree"}',
      "  CRYSTAL_DISPATCH: {\"prompt\": \"write the tests\"}",
      "CRYSTAL_DISPATCH: {not json}",
      'CRYSTAL_DISPATCH: {"cwd": "packages/core"}',
      "CRYSTAL_DISPATCH:",
    ].join("\n");
    const specs = extractDispatches(text);
    expect(specs).toEqual([
      { prompt: "write the parser", isolation: "worktree" },
      { prompt: "write the tests" },
    ]);
  });

  it("surfaces dispatch events from an assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: 'plan:\nCRYSTAL_DISPATCH: {"prompt": "do the slice"}' },
        ],
      },
    });
    const events = parseClaudeStreamLine(line);
    expect(events).toContainEqual({ type: "dispatch", spec: { prompt: "do the slice" } });
  });
});

describe("createAgentRun roles", () => {
  it("infers worker role from a parent run", () => {
    const run = createAgentRun({ prompt: "do a slice", parentRunId: "run-manager" });
    expect(run.parentRunId).toBe("run-manager");
    expect(run.role).toBe("worker");
  });

  it("leaves standalone runs role-less and honors an explicit manager", () => {
    expect(createAgentRun({ prompt: "solo" }).role).toBeNull();
    expect(createAgentRun({ prompt: "coordinate", role: "manager" }).role).toBe("manager");
  });
});

describe("groupRunsByManager", () => {
  const run = (id: string, over: Partial<AgentRun> = {}): AgentRun =>
    ({ ...createAgentRun({ prompt: id }), id, createdAt: `2026-01-01T00:00:0${id.at(-1)}Z`, ...over });

  it("nests workers under their manager and keeps standalone runs flat", () => {
    const manager = run("m1", { role: "manager" });
    const w1 = run("w1", { parentRunId: "m1", role: "worker" });
    const w2 = run("w2", { parentRunId: "m1", role: "worker" });
    const solo = run("s3");
    // Store hands runs back newest-first; workers arrive before their manager.
    const nodes = groupRunsByManager([w2, w1, solo, manager]);

    // Roots keep input order; workers are pulled out from the top level.
    expect(nodes.map((n) => n.run.id)).toEqual(["s3", "m1"]);
    const managerNode = nodes.find((n) => n.run.id === "m1")!;
    expect(managerNode.workers.map((w) => w.run.id)).toEqual(["w1", "w2"]); // oldest-first
  });

  it("promotes orphaned workers to roots so nothing is hidden", () => {
    const orphan = run("w9", { parentRunId: "gone", role: "worker" });
    const nodes = groupRunsByManager([orphan]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.run.id).toBe("w9");
    expect(nodes[0]!.workers).toEqual([]);
  });

  it("collapses a resume chain to one node faced by its latest turn", () => {
    const first = run("t1");
    const second = run("t2", { resumedFromRunId: "t1" });
    const third = run("t3", { resumedFromRunId: "t2" });
    // Newest-first input, as the store hands them back.
    const nodes = groupRunsByManager([third, second, first]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.run.id).toBe("t3"); // the face is the latest turn
    expect(nodes[0]!.turns.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("merges session-only turns into their chain (console resumes carry no run link)", () => {
    const first = run("t1", { sessionId: "sess-a" });
    const consoleTurn = run("t2", { sessionId: "sess-a" }); // no resumedFromRunId
    const nodes = groupRunsByManager([consoleTurn, first]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.run.id).toBe("t2");
    expect(nodes[0]!.turns.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("keeps a resumed manager's workers under the one session node", () => {
    const manager = run("m1", { role: "manager" });
    const worker = run("w2", { parentRunId: "m1", role: "worker" });
    const woken = run("m3", { resumedFromRunId: "m1", role: "manager" });
    const nodes = groupRunsByManager([woken, worker, manager]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.run.id).toBe("m3");
    expect(nodes[0]!.workers.map((w) => w.run.id)).toEqual(["w2"]);
  });
});
