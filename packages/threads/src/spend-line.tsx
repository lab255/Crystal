import { formatRunCost } from "@crystal/client";
import type { DeliveryStatus, ProgramStatus } from "@crystal/core";
import { Badge, cn } from "@crystal/ui";

/**
 * Status tones + spend rendering shared by the program-thread surfaces
 * (moved from the retired hub package). A colour always means one thing; a
 * program's states are a subset of a delivery's, so one table serves both.
 */
export const STATUS_TONES: Record<
  DeliveryStatus,
  "neutral" | "violet" | "amber" | "emerald" | "rose" | "slate"
> = {
  pending: "neutral",
  running: "violet",
  paused: "amber",
  completed: "emerald",
  failed: "rose",
  cancelled: "slate",
};

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: "Pending",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const PAUSED_BY_LABEL = {
  user: "User",
  stall: "No progress",
  budget: "Budget limit",
} as const;

export function StatusBadge({ status }: { status: ProgramStatus | DeliveryStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABEL[status]}</Badge>;
}

/**
 * A budget field's text as a number: empty or unparseable means "no ceiling",
 * which is a real state rather than an error. Zero or negative is not a
 * ceiling — it would read as "already exhausted".
 */
export function parseBudget(text: string): number | null {
  const n = Number(text);
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

/** Spend against a budget, with the ceiling turning red once it is spent. */
export function SpendLine({
  costUsd,
  budgetUsd,
  stale = false,
  showUnbudgeted = false,
  suffix,
}: {
  costUsd: number;
  budgetUsd: number | null | undefined;
  /** The displayed cost is a lower bound because some live spend is unreadable. */
  stale?: boolean;
  showUnbudgeted?: boolean;
  suffix?: React.ReactNode;
}) {
  const exhausted = budgetUsd != null && costUsd >= budgetUsd;
  return (
    <span
      className="flex items-center gap-1"
      title={stale ? "Lower bound — some live delivery spend is currently unreadable" : undefined}
    >
      {stale ? `≥${formatRunCost(costUsd)}` : formatRunCost(costUsd)}
      {budgetUsd != null ? (
        <span className={cn(exhausted && "text-danger")}> of ${budgetUsd.toFixed(2)}</span>
      ) : showUnbudgeted ? (
        <span className="text-ink-faint"> (no budget — unbounded)</span>
      ) : null}
      {suffix}
    </span>
  );
}
