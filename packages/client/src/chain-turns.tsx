import type { AgentRun } from "@crystal/core";
import { Tooltip, cn } from "@crystal/ui";
import { formatRunCost } from "./run-transcript.js";

/**
 * A turn is "expensive" relative to its own chain: at least this much, and
 * carrying an outsized share of the chain's spend. Absolute-only thresholds
 * mislabel every turn of a costly chain; share-only ones dot a $0.02 turn in
 * a $0.04 chain.
 */
function expensiveTurns(runs: readonly AgentRun[]): Set<string> {
  const costs = runs.map((r) => r.costUsd ?? 0);
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= 0) return new Set();
  const threshold = Math.max(0.1, total / Math.max(runs.length, 1));
  const out = new Set<string>();
  for (const r of runs) {
    if (r.costUsd != null && r.costUsd >= threshold) out.add(r.id);
  }
  return out;
}

/**
 * The horizontal turn-selector strip over one resume chain: numbered turns,
 * oldest first, with the viewed turn highlighted and a cost dot on turns that
 * dominate the chain's spend. Fully controlled — the adopting surface owns
 * which turn is active and where selection routes (nav store, local state…).
 * Renders nothing for a chain of one: a strip with a single "1" is noise.
 */
export function ChainTurns({
  runs,
  activeId,
  onSelect,
  className,
}: {
  /** The chain's turns, oldest first (see `chainOf`). */
  runs: readonly AgentRun[];
  activeId: string | null;
  onSelect: (runId: string) => void;
  className?: string;
}) {
  if (runs.length < 2) return null;
  const expensive = expensiveTurns(runs);
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto", className)}>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">Turns</span>
      {runs.map((r, i) => (
        <Tooltip
          key={r.id}
          content={`Turn ${i + 1} · ${r.status} · ${formatRunCost(r.costUsd)}`}
        >
          <button
            type="button"
            aria-label={`Turn ${i + 1}`}
            aria-current={activeId === r.id ? "true" : undefined}
            onClick={() => onSelect(r.id)}
            className={cn(
              "relative shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors",
              activeId === r.id
                ? "bg-surface-3 text-ink"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {i + 1}
            {expensive.has(r.id) ? (
              <span
                aria-label="expensive turn"
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-warn"
              />
            ) : null}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
