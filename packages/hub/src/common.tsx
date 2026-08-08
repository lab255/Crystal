import { useCallback } from "react";
import { formatRunCost, useNavUpdate, useWorkspaces, type NavPatch } from "@crystal/client";
import type { DeliveryStatus, ProgramStatus } from "@crystal/core";
import { Badge, cn } from "@crystal/ui";

/**
 * Status tones, shared by every Hub surface so a colour always means one
 * thing. A program's states are a subset of a delivery's, so one table serves
 * both.
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

/** A program's/delivery's status as a badge — one import instead of two. */
export function StatusBadge({ status }: { status: ProgramStatus | DeliveryStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{status}</Badge>;
}

/**
 * A segmented-control tab, used by the mode's view switcher and the start
 * panel's shape switcher. Wrap a row of them in {@link TabStrip}.
 */
export function SegmentedTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function TabStrip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5", className)}>
      {children}
    </div>
  );
}

/**
 * A budget field's text as a number: empty or unparseable means "no ceiling",
 * which is a real state rather than an error.
 */
export function parseBudget(text: string): number | null {
  const n = Number(text);
  // Zero or negative is not a ceiling — it would read as "already exhausted"
  // and wedge the program in a pause that raising the budget cannot clear.
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

/**
 * Navigate into another project. Every jump out of the Hub crosses a
 * workspace boundary, so the target workspace is focused *first* — the same
 * rule the code map follows at its "all workspaces" level.
 */
export function useCrossWorkspaceNav(): (ws: string, patch: NavPatch) => void {
  const nav = useNavUpdate();
  const setActive = useWorkspaces((s) => s.setActive);
  return useCallback(
    (ws, patch) => {
      setActive(ws);
      nav({ ws, ...patch });
    },
    [nav, setActive],
  );
}

/** The menu context every Hub view passes to the pure builders in menus.ts. */
export function useHubMenuContext(): {
  nav: (patch: NavPatch) => void;
  setActiveWorkspace: (ws: string) => void;
  copy: (text: string) => void;
} {
  const nav = useNavUpdate();
  const setActiveWorkspace = useWorkspaces((s) => s.setActive);
  return { nav, setActiveWorkspace, copy: copyText };
}

/** Section label used across the Hub panes. */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-ink-faint",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Spend against a budget, with the ceiling turning red once it is spent. */
export function SpendLine({
  costUsd,
  budgetUsd,
  stale = false,
  /** Make an absent ceiling explicit — for detail views, not dense rows. */
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
        <span className={cn(exhausted && "text-danger")}> / ${budgetUsd.toFixed(2)}</span>
      ) : showUnbudgeted ? (
        <span className="text-ink-faint"> (no budget — unbounded)</span>
      ) : null}
      {suffix}
    </span>
  );
}

/** Copy to the clipboard, best-effort (no clipboard permission = no-op). */
export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}
