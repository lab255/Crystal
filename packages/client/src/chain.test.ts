import { describe, expect, it } from "vitest";
import type { AgentRun } from "@crystal/core";
import { chainOf } from "./chain.js";

/** Minimal run factory — only the fields chain derivation reads. */
function run(init: {
  id: string;
  createdAt: string;
  resumedFromRunId?: string | null;
  parentRunId?: string | null;
  sessionId?: string | null;
  role?: "manager" | "worker" | null;
}): AgentRun {
  return {
    id: init.id,
    taskId: null,
    projectId: null,
    repoId: null,
    cwd: ".",
    isolation: "none",
    worktreePath: null,
    branch: null,
    prompt: `prompt of ${init.id}`,
    agentId: null,
    parentRunId: init.parentRunId ?? null,
    resumedFromRunId: init.resumedFromRunId ?? null,
    role: init.role ?? null,
    purpose: null,
    terminalId: null,
    terminalWs: null,
    tags: [],
    status: "completed",
    sessionId: init.sessionId ?? null,
    model: null,
    usage: null,
    costUsd: null,
    turns: null,
    durationMs: null,
    resultText: null,
    filesTouched: [],
    createdAt: init.createdAt,
    startedAt: null,
    endedAt: null,
  };
}

describe("chainOf", () => {
  it("walks resumedFromRunId links from any turn, ordered by createdAt", () => {
    const a = run({ id: "a", createdAt: "2026-07-01T00:00:00Z" });
    const b = run({ id: "b", createdAt: "2026-07-01T01:00:00Z", resumedFromRunId: "a" });
    const c = run({ id: "c", createdAt: "2026-07-01T02:00:00Z", resumedFromRunId: "b" });
    const other = run({ id: "x", createdAt: "2026-07-01T00:30:00Z" });
    const runs = [c, other, a, b]; // stores hand runs back newest-first

    // Same chain from the middle, the root, or the tip.
    for (const anchor of [a, b, c]) {
      expect(chainOf(runs, anchor).map((r) => r.id)).toEqual(["a", "b", "c"]);
    }
  });

  it("joins turns by sessionId when no resume link was recorded", () => {
    // Agent-console turns resume by session id only — no resumedFromRunId.
    const first = run({ id: "t1", createdAt: "2026-07-02T00:00:00Z", sessionId: "sess-1" });
    const second = run({ id: "t2", createdAt: "2026-07-02T01:00:00Z", sessionId: "sess-1" });
    const stranger = run({ id: "t3", createdAt: "2026-07-02T02:00:00Z", sessionId: "sess-9" });

    expect(chainOf([second, stranger, first], first).map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("bridges resume links and session equality transitively", () => {
    // b resumed a; c shares only b's session (link to b never recorded);
    // d resumed c. All four are one logical session.
    const a = run({ id: "a", createdAt: "2026-07-03T00:00:00Z", sessionId: null });
    const b = run({ id: "b", createdAt: "2026-07-03T01:00:00Z", resumedFromRunId: "a", sessionId: "s" });
    const c = run({ id: "c", createdAt: "2026-07-03T02:00:00Z", sessionId: "s" });
    const d = run({ id: "d", createdAt: "2026-07-03T03:00:00Z", resumedFromRunId: "c" });

    expect(chainOf([d, c, b, a], a).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(chainOf([d, c, b, a], d).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not treat a manager's workers as chain turns", () => {
    const manager = run({ id: "m", createdAt: "2026-07-04T00:00:00Z", role: "manager", sessionId: "m-sess" });
    const worker = run({
      id: "w",
      createdAt: "2026-07-04T00:30:00Z",
      parentRunId: "m",
      role: "worker",
      sessionId: "w-sess",
    });
    const wake = run({
      id: "m2",
      createdAt: "2026-07-04T01:00:00Z",
      resumedFromRunId: "m",
      role: "manager",
    });

    expect(chainOf([wake, worker, manager], manager).map((r) => r.id)).toEqual(["m", "m2"]);
    // And from the worker's side, its chain is itself alone.
    expect(chainOf([wake, worker, manager], worker).map((r) => r.id)).toEqual(["w"]);
  });

  it("contains the anchor even when it is missing from the list", () => {
    const lone = run({ id: "solo", createdAt: "2026-07-05T00:00:00Z" });
    expect(chainOf([], lone).map((r) => r.id)).toEqual(["solo"]);
  });

  it("survives a resume-link cycle without hanging", () => {
    // Corrupt data (a↔b) must not loop forever; both stay one chain.
    const a = run({ id: "a", createdAt: "2026-07-06T00:00:00Z", resumedFromRunId: "b" });
    const b = run({ id: "b", createdAt: "2026-07-06T01:00:00Z", resumedFromRunId: "a" });
    expect(chainOf([a, b], a).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
