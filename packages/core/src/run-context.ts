import {
  budgetWarningDue,
  type Workflow,
  type WorkflowSpend,
} from "./workflow.js";

export type WorkflowBudgetTone = "unlimited" | "healthy" | "warning" | "exhausted";

export interface WorkflowBudgetDisplay {
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  warning: boolean;
  exhausted: boolean;
  tone: WorkflowBudgetTone;
}

/** Pure, display-ready budget state derived from the workflow + accounting kernel. */
export function deriveWorkflowBudgetState(
  workflow: Pick<Workflow, "budgetUsd" | "budgetWarnedAt">,
  spend: Pick<WorkflowSpend, "costUsd">,
): WorkflowBudgetDisplay {
  const budgetUsd = workflow.budgetUsd ?? null;
  const remainingUsd = budgetUsd == null ? null : budgetUsd - spend.costUsd;
  const exhausted = remainingUsd != null && remainingUsd <= 0;
  const warning =
    !exhausted &&
    (workflow.budgetWarnedAt != null ||
      budgetWarningDue({
        budgetUsd,
        spentUsd: spend.costUsd,
        remainingUsd,
        exhausted,
      }));
  return {
    budgetUsd,
    spentUsd: spend.costUsd,
    remainingUsd,
    warning,
    exhausted,
    tone: exhausted ? "exhausted" : warning ? "warning" : budgetUsd == null ? "unlimited" : "healthy",
  };
}
