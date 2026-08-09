import { describe, expect, it } from "vitest";
import {
  isQuestionActionable,
  livenessIndex,
  questionDeliverability,
  type LivenessRun,
} from "./question-liveness.js";

function run(id: string, over: Partial<LivenessRun> = {}): LivenessRun {
  return { id, status: "completed", createdAt: `2026-01-01T00:00:0${id.length % 10}Z`, ...over };
}

describe("questionDeliverability", () => {
  it("unknown when the runs index is unavailable", () => {
    expect(questionDeliverability({ runId: "run_1" }, null)).toBe("unknown");
    expect(questionDeliverability({ runId: "run_1" }, undefined)).toBe("unknown");
  });

  it("undeliverable when there is no asking run or its record is absent", () => {
    const index = livenessIndex([run("run_1", { sessionId: "s1" })]);
    expect(questionDeliverability({ runId: null }, index)).toBe("undeliverable");
    expect(questionDeliverability({ runId: "run_missing" }, index)).toBe("undeliverable");
  });

  it("deliverable while any run of the chain is live (delivery queues)", () => {
    const index = livenessIndex([
      run("run_root", { createdAt: "t1" }),
      run("run_turn2", { createdAt: "t2", resumedFromRunId: "run_root", status: "running" }),
    ]);
    expect(questionDeliverability({ runId: "run_root" }, index)).toBe("deliverable");
  });

  it("deliverable for a settled (even failed) chain with a resumable session id", () => {
    const index = livenessIndex([
      run("run_root", { createdAt: "t1", sessionId: "sess_1" }),
      run("run_turn2", { createdAt: "t2", resumedFromRunId: "run_root", status: "failed" }),
    ]);
    // The question rode the first turn; the chain resolves to its latest.
    expect(questionDeliverability({ runId: "run_root" }, index)).toBe("deliverable");
    expect(questionDeliverability({ runId: "run_turn2" }, index)).toBe("deliverable");
  });

  it("undeliverable when the chain's latest turn was cancelled", () => {
    const index = livenessIndex([
      run("run_root", { createdAt: "t1", sessionId: "sess_1" }),
      run("run_turn2", { createdAt: "t2", resumedFromRunId: "run_root", status: "cancelled" }),
    ]);
    expect(questionDeliverability({ runId: "run_root" }, index)).toBe("undeliverable");
  });

  it("undeliverable for a settled chain that never got a session id", () => {
    const index = livenessIndex([run("run_root", { createdAt: "t1", status: "failed" })]);
    expect(questionDeliverability({ runId: "run_root" }, index)).toBe("undeliverable");
  });

  it("follows handoff lineage to the continuation chain (same as deliverToChain)", () => {
    const index = livenessIndex([
      // Retired chain: overflowed, no live run, session id present but the
      // handoff supersedes it.
      run("run_old", { createdAt: "t1", status: "failed", sessionId: "sess_old" }),
      // Fresh session seeded from the handoff note.
      run("run_new", { createdAt: "t2", handoffFromRunId: "run_old", sessionId: "sess_new" }),
    ]);
    expect(questionDeliverability({ runId: "run_old" }, index)).toBe("deliverable");

    // If the continuation is cancelled, the whole lineage is dead.
    const dead = livenessIndex([
      run("run_old", { createdAt: "t1", status: "failed", sessionId: "sess_old" }),
      run("run_new", { createdAt: "t2", handoffFromRunId: "run_old", status: "cancelled" }),
    ]);
    expect(questionDeliverability({ runId: "run_old" }, dead)).toBe("undeliverable");
  });

  it("walks resume chains through the handoff (question on a pre-handoff turn)", () => {
    const index = livenessIndex([
      run("run_a", { createdAt: "t1", status: "completed", sessionId: "s_a" }),
      run("run_b", { createdAt: "t2", resumedFromRunId: "run_a", status: "failed" }),
      run("run_c", { createdAt: "t3", handoffFromRunId: "run_b", status: "running" }),
    ]);
    expect(questionDeliverability({ runId: "run_a" }, index)).toBe("deliverable");
  });
});

describe("isQuestionActionable", () => {
  const openQ = { runId: "run_dead", answer: null, closed: null };

  it("excludes open+undeliverable (stale), keeps unknown counted", () => {
    const index = livenessIndex([run("run_live", { status: "running" })]);
    expect(isQuestionActionable(openQ, index)).toBe(false); // stale
    expect(isQuestionActionable(openQ, null)).toBe(true); // unknown stays counted
    expect(isQuestionActionable({ ...openQ, runId: "run_live" }, index)).toBe(true);
  });

  it("closed questions are never actionable", () => {
    const index = livenessIndex([run("run_live", { status: "running" })]);
    expect(
      isQuestionActionable({ runId: "run_live", answer: "done", closed: null }, index),
    ).toBe(false);
    expect(
      isQuestionActionable(
        {
          runId: "run_live",
          answer: null,
          closed: { at: "t", reason: "expired", note: null, by: "system" },
        },
        index,
      ),
    ).toBe(false);
  });
});
