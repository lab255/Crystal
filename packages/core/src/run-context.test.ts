import { describe, expect, it } from "vitest";
import { deriveWorkflowBudgetState } from "./run-context.js";

describe("deriveWorkflowBudgetState", () => {
  it("represents an unset budget as unlimited", () => {
    expect(
      deriveWorkflowBudgetState({ budgetUsd: null, budgetWarnedAt: null }, { costUsd: 4 }),
    ).toEqual({
      budgetUsd: null,
      spentUsd: 4,
      remainingUsd: null,
      warning: false,
      exhausted: false,
      tone: "unlimited",
    });
  });

  it("raises the warning state at the threshold or after the notice was armed", () => {
    expect(
      deriveWorkflowBudgetState({ budgetUsd: 10, budgetWarnedAt: null }, { costUsd: 7.99 }),
    ).toMatchObject({ warning: false, exhausted: false, tone: "healthy" });
    expect(
      deriveWorkflowBudgetState({ budgetUsd: 10, budgetWarnedAt: null }, { costUsd: 8 }),
    ).toMatchObject({ warning: true, exhausted: false, tone: "warning" });
    expect(
      deriveWorkflowBudgetState(
        { budgetUsd: 10, budgetWarnedAt: "2026-08-20T00:00:00Z" },
        { costUsd: 7 },
      ),
    ).toMatchObject({ warning: true, tone: "warning" });
  });

  it("makes exhaustion take precedence over warning", () => {
    expect(
      deriveWorkflowBudgetState(
        { budgetUsd: 10, budgetWarnedAt: "2026-08-20T00:00:00Z" },
        { costUsd: 11 },
      ),
    ).toMatchObject({ remainingUsd: -1, warning: false, exhausted: true, tone: "exhausted" });
  });
});
