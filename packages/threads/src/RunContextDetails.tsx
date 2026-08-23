import { AlertTriangle, ChevronRight, ShieldAlert } from "lucide-react";
import {
  deriveWorkflowBudgetState,
  denialsForWorkflow,
  envGaps,
  premiseGaps,
  templateOf,
  templateScope,
  WORKFLOW_TEMPLATES,
  type GrantsLedger,
  type Workflow,
  type WorkflowSpend,
  type WorkflowTemplate,
} from "@crystal/core";
import { formatRunCost } from "@crystal/client";
import { Badge, cn } from "@crystal/ui";

const SCOPE_LABELS = {
  builtin: "built-in",
  global: "library",
  project: "project",
} as const;

export function RunContextDetails({
  workflow,
  spend,
  ledger,
  templates,
}: {
  workflow: Workflow;
  spend: WorkflowSpend;
  ledger: GrantsLedger | null;
  templates: readonly WorkflowTemplate[];
}) {
  const budget = deriveWorkflowBudgetState(workflow, spend);
  const denials = ledger ? denialsForWorkflow(ledger, workflow.id) : [];
  const template = templateOf(workflow);
  const basedOn = template.basedOn
    ? templates.find((candidate) => candidate.id === template.basedOn) ??
      WORKFLOW_TEMPLATES[template.basedOn]
    : null;
  const environmentGaps = workflow.env ? envGaps(workflow.env) : [];
  const failedPremises = workflow.premise ? premiseGaps(workflow.premise) : [];
  const turns = workflow.turnLog.slice(-5).reverse();

  return (
    <details className="group border-t border-edge bg-surface-1/60">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-1.5 text-[11px] font-medium text-ink-muted [&::-webkit-details-marker]:hidden hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-blue">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        Run context
        {denials.length ? (
          <Badge tone="rose" className="ml-1">
            <ShieldAlert className="h-2.5 w-2.5" />
            {denials.length} denied {denials.length === 1 ? "tool" : "tools"}
          </Badge>
        ) : null}
        {budget.warning || budget.exhausted ? (
          <Badge tone={budget.exhausted ? "rose" : "amber"} className="ml-1">
            <AlertTriangle className="h-2.5 w-2.5" />
            {budget.exhausted ? "BUDGET EXHAUSTED" : "BUDGET WARNING"}
          </Badge>
        ) : null}
      </summary>

      <div className="grid gap-x-6 gap-y-2 border-t border-edge px-4 py-3 text-[11px] sm:grid-cols-2">
        <ContextRow label="Budget & spend">
          <span>{formatRunCost(budget.spentUsd)} spent</span>
          <span className="text-ink-faint">·</span>
          <span>{budget.budgetUsd == null ? "no budget" : `${formatRunCost(budget.budgetUsd)} budget`}</span>
          {workflow.runCapUsd != null ? (
            <>
              <span className="text-ink-faint">·</span>
              <span>{formatRunCost(workflow.runCapUsd)} per-run cap</span>
            </>
          ) : null}
        </ContextRow>

        <ContextRow label="Template">
          <span>{template.name}</span>
          <Badge tone="neutral">{SCOPE_LABELS[templateScope(template)]}</Badge>
          {basedOn ? <span className="text-ink-faint">based on {basedOn.name}</span> : null}
        </ContextRow>

        <ContextRow label="Recent turns" className="sm:col-span-2">
          {turns.length ? (
            turns.map((turn) => (
              <Badge
                key={turn.runId}
                tone={turn.progressed ? "neutral" : "rose"}
                title={turn.progressed ? "Progress recorded" : "No progress recorded"}
              >
                {formatRunCost(turn.costUsd)}{turn.progressed ? "" : " · no progress"}
              </Badge>
            ))
          ) : (
            <span className="text-ink-faint">No settled manager turns yet</span>
          )}
        </ContextRow>

        <ContextRow label="Grants" className="sm:col-span-2">
          {ledger?.allowAll ? <Badge tone="amber">allow all</Badge> : null}
          {ledger?.allowedTools.length ? (
            ledger.allowedTools.map((tool) => <Badge key={tool}>{tool}</Badge>)
          ) : (
            <span className="text-ink-faint">No workspace tool patterns</span>
          )}
        </ContextRow>

        {denials.map((denial) => (
          <ContextRow key={denial.tool} label="Denied tool" className="sm:col-span-2">
            <span className="font-medium text-accent-rose">{denial.tool}</span>
            <span>denied {denial.count} {denial.count === 1 ? "time" : "times"}</span>
          </ContextRow>
        ))}

        {environmentGaps.map((gap) => (
          <ContextRow key={gap.id} label="Environment gap" className="sm:col-span-2">
            <span className="font-medium text-accent-amber">{gap.label} missing</span>
            <span className="text-ink-faint">expected because {gap.reason}</span>
          </ContextRow>
        ))}

        {failedPremises.map((gap, index) => (
          <ContextRow key={`${gap.raw}-${index}`} label="Premise gap" className="sm:col-span-2">
            <span className="font-medium text-accent-rose">{gap.raw}</span>
            <span className="text-ink-faint">{gap.detail ?? "does not hold"}</span>
          </ContextRow>
        ))}
      </div>
    </details>
  );
}

function ContextRow({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      <span className="w-24 shrink-0 font-medium text-ink-muted">{label}</span>
      {children}
    </div>
  );
}
