import { describe, expect, it } from "vitest";
import { createAgentRun } from "./agent.js";
import {
  addDelivery,
  buildProgramManagerPrompt,
  createProgram,
  cyclicDeliveries,
  deliveryBlockers,
  deliveryGoalText,
  deliveryReadiness,
  deliverySettledNotice,
  emptyDeliverySpend,
  managerSpend,
  patchDelivery,
  portfolioStatusText,
  programBudgetState,
  programIdOfRun,
  programOutcome,
  programSpend,
  programStatusText,
  programTag,
  readyDeliveries,
  type Program,
} from "./hub.js";

/** A program with an auth delivery and a web delivery that depends on it. */
function twoProjectProgram(): {
  program: Program;
  authId: string;
  webId: string;
} {
  const base = createProgram({ name: "SSO everywhere", goal: "Single sign-on across the suite." });
  const first = addDelivery(base, {
    projectRoot: "/repos/auth-service",
    brief: "Issue and verify OIDC tokens.",
  });
  const second = addDelivery(first.program, {
    projectRoot: "/repos/web-console",
    brief: "Log in through the new provider.",
    dependsOn: [first.delivery.id],
  });
  return { program: second.program, authId: first.delivery.id, webId: second.delivery.id };
}

describe("program deliveries", () => {
  it("derives the project name from the root and keeps the graph acyclic", () => {
    const { program, authId, webId } = twoProjectProgram();
    expect(program.deliveries.map((d) => d.projectName)).toEqual(["auth-service", "web-console"]);
    expect(cyclicDeliveries(program)).toEqual([]);
    expect(deliveryBlockers(program, program.deliveries[1]!)).toEqual([authId]);
    expect(deliveryBlockers(program, program.deliveries[0]!)).toEqual([]);
    expect(webId).toMatch(/^dlv_/);
  });

  it("rejects a dependency on a delivery that does not exist", () => {
    const program = createProgram({ name: "p", goal: "g" });
    expect(() =>
      addDelivery(program, { projectRoot: "/repos/a", brief: "b", dependsOn: ["dlv_nope"] }),
    ).toThrow(/Unknown delivery dependency/);
  });

  it("stamps endedAt when a delivery reaches a terminal state and clears it on re-dispatch", () => {
    const { program, authId } = twoProjectProgram();
    const failed = patchDelivery(program, authId, { status: "failed" }, "2026-01-01T00:00:00.000Z");
    expect(failed.deliveries[0]!.endedAt).toBe("2026-01-01T00:00:00.000Z");
    const retried = patchDelivery(failed, authId, { status: "running" });
    expect(retried.deliveries[0]!.endedAt).toBeNull();
    expect(retried.deliveries[0]!.dispatchedAt).not.toBeNull();
  });
});

describe("readiness", () => {
  it("holds a delivery until its dependency completes", () => {
    const { program, authId, webId } = twoProjectProgram();
    expect(readyDeliveries(program).map((d) => d.id)).toEqual([authId]);
    expect(deliveryReadiness(program, program.deliveries[1]!).reason).toMatch(/Blocked by/);

    const running = patchDelivery(program, authId, { status: "running" });
    expect(readyDeliveries(running)).toEqual([]);

    const done = patchDelivery(running, authId, { status: "completed" });
    expect(readyDeliveries(done).map((d) => d.id)).toEqual([webId]);
  });

  it("never reports two deliveries on the same project as ready at once", () => {
    const base = createProgram({ name: "p", goal: "g" });
    const first = addDelivery(base, { projectRoot: "/repos/api", brief: "phase one" });
    const second = addDelivery(first.program, { projectRoot: "/repos/api", brief: "phase two" });
    expect(readyDeliveries(second.program).map((d) => d.id)).toEqual([first.delivery.id]);

    // …and once one is live, the other is refused with the reason why.
    const live = patchDelivery(second.program, first.delivery.id, { status: "running" });
    const readiness = deliveryReadiness(live, live.deliveries[1]!);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/one orchestrator per project/);
  });

  it("dispatches nothing while the program is not running", () => {
    const { program } = twoProjectProgram();
    const paused: Program = { ...program, status: "paused" };
    expect(readyDeliveries(paused)).toEqual([]);
    expect(deliveryReadiness(paused, paused.deliveries[0]!).reason).toBe("Program is paused.");
  });

  it("a failed dependency blocks forever — the owner decides what happens next", () => {
    const { program, authId, webId } = twoProjectProgram();
    const failed = patchDelivery(program, authId, { status: "failed" });
    expect(deliveryBlockers(failed, failed.deliveries[1]!)).toEqual([authId]);
    expect(readyDeliveries(failed)).toEqual([]);
    expect(webId).toBeDefined();
  });
});

describe("programOutcome", () => {
  it("is null while work remains, completed when all landed, failed if any did not", () => {
    const { program, authId, webId } = twoProjectProgram();
    expect(programOutcome(program)).toBeNull();
    expect(programOutcome(createProgram({ name: "empty", goal: "g" }))).toBeNull();

    const half = patchDelivery(program, authId, { status: "completed" });
    expect(programOutcome(half)).toBeNull();

    const all = patchDelivery(half, webId, { status: "completed" });
    expect(programOutcome(all)).toBe("completed");

    const partial = patchDelivery(half, webId, { status: "cancelled" });
    expect(programOutcome(partial)).toBe("failed");
  });
});

describe("spend", () => {
  it("sums deliveries plus the manager's own coordination cost", () => {
    const spend = programSpend(
      {
        d1: { costUsd: 1.5, totalTokens: 1000, runCount: 2, liveRunCount: 1 },
        d2: { costUsd: 0.5, totalTokens: 500, runCount: 1, liveRunCount: 0 },
      },
      { costUsd: 0.25, totalTokens: 100, runCount: 3, liveRunCount: 0 },
    );
    expect(spend.costUsd).toBeCloseTo(2.25);
    expect(spend.runCount).toBe(6);
    expect(spend.liveRunCount).toBe(1);
    expect(spend.manager.costUsd).toBe(0.25);
    expect(programSpend({}).costUsd).toBe(0);
  });

  it("attributes manager runs by their program tag", () => {
    const program = createProgram({ name: "p", goal: "g" });
    const mine = createAgentRun({ prompt: "manage", tags: [programTag(program.id)] });
    mine.costUsd = 0.4;
    mine.status = "running";
    const other = createAgentRun({ prompt: "manage", tags: [programTag("prog_other")] });
    other.costUsd = 9;

    const spend = managerSpend(program.id, [mine, other]);
    expect(spend.costUsd).toBeCloseTo(0.4);
    expect(spend.runCount).toBe(1);
    expect(spend.liveRunCount).toBe(1);
    expect(programIdOfRun(mine)).toBe(program.id);
    expect(programIdOfRun(createAgentRun({ prompt: "x" }))).toBeNull();
  });

  it("marks the budget exhausted once spend crosses it", () => {
    const program = { ...createProgram({ name: "p", goal: "g", budgetUsd: 2 }) };
    const under = programBudgetState(program, programSpend({ d: { ...emptyDeliverySpend(), costUsd: 1 } }));
    expect(under.exhausted).toBe(false);
    expect(under.remainingUsd).toBe(1);

    const over = programBudgetState(program, programSpend({ d: { ...emptyDeliverySpend(), costUsd: 2 } }));
    expect(over.exhausted).toBe(true);

    const unlimited = programBudgetState(createProgram({ name: "p", goal: "g" }), programSpend({}));
    expect(unlimited.exhausted).toBe(false);
    expect(unlimited.remainingUsd).toBeNull();
  });
});

describe("agent-facing rendering", () => {
  it("hands a delivery the program's intent, its own brief, and its upstream results", () => {
    const { program, authId, webId } = twoProjectProgram();
    const done = patchDelivery(program, authId, {
      status: "completed",
      summary: "Tokens issued at /oauth/token.",
    });
    const text = deliveryGoalText(done, done.deliveries.find((d) => d.id === webId)!);
    expect(text).toContain("Single sign-on across the suite.");
    expect(text).toContain("Log in through the new provider.");
    expect(text).toContain("auth-service"); // sibling context
    expect(text).toContain("Tokens issued at /oauth/token."); // upstream result
    expect(text).toContain("ask_question");
  });

  it("renders status with blockers, readiness and budget", () => {
    const { program, authId } = twoProjectProgram();
    const withBudget: Program = { ...program, budgetUsd: 10 };
    const text = programStatusText(
      withBudget,
      programSpend({ [authId]: { costUsd: 3, totalTokens: 12_000, runCount: 4, liveRunCount: 1 } }),
    );
    expect(text).toContain("SSO everywhere");
    expect(text).toContain(`blocked by ${authId}`);
    expect(text).toMatch(/Ready to dispatch: dlv_/);
    expect(text).toContain("budget $10.00, remaining $7.00");
  });

  it("names the deliveries a settled one unblocked", () => {
    const { program, authId, webId } = twoProjectProgram();
    const done = patchDelivery(program, authId, { status: "completed", summary: "shipped" });
    const notice = deliverySettledNotice(done, done.deliveries[0]!);
    expect(notice).toContain("completed");
    expect(notice).toContain("shipped");
    expect(notice).toContain(webId);
  });

  it("tells the portfolio story across programs, and says so when there are none", () => {
    const { program } = twoProjectProgram();
    expect(portfolioStatusText([])).toMatch(/No programs yet/);
    const text = portfolioStatusText([{ program, spend: programSpend({}) }]);
    expect(text).toContain("1 program(s), 1 live");
    // One separator per program — no empty block between the header and the
    // first entry (the separator joins every element, blank lines included).
    expect(text.split("\n---\n")).toHaveLength(2);
  });

  it("gives the program manager its standing protocol", () => {
    const { program } = twoProjectProgram();
    const prompt = buildProgramManagerPrompt({ ...program, budgetUsd: 50 });
    expect(prompt).toContain("PROGRAM MANAGER");
    expect(prompt).toContain("$50.00");
    expect(prompt).toContain("dispatch_program");
    expect(prompt).toContain("auth-service");
    expect(prompt).toContain("complete_program");
  });
});

describe("dispatch report premise gaps", () => {
  it("renders failed brief claims loudly, per dispatched delivery", async () => {
    const { dispatchReportText } = await import("./hub.js");
    const text = dispatchReportText({
      dispatched: [
        {
          deliveryId: "dlv_1",
          projectName: "api",
          ws: "ws1",
          workflowId: "wf_1",
          premiseGaps: ["assert: branch release/2.3 — no such local or origin branch"],
        },
      ],
      skipped: [],
    });
    expect(text).toContain("FAILED PREMISES");
    expect(text).toContain("assert: branch release/2.3 — no such local or origin branch");
    // A clean dispatch says nothing about premises.
    expect(
      dispatchReportText({
        dispatched: [{ deliveryId: "dlv_2", projectName: "web", ws: "ws2", workflowId: "wf_2" }],
        skipped: [],
      }),
    ).not.toContain("FAILED PREMISES");
  });
});
