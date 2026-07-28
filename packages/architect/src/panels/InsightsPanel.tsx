import { useMemo } from "react";
import { AlertTriangle, CircleSlash2, RefreshCcwDot, Spline, X } from "lucide-react";
import { computeSystemInsights, type SystemOverview } from "@crystal/core";
import { Button, EmptyState, Tooltip } from "@crystal/ui";

/**
 * Architecture insights on the unified canvas: dependency cycles, layering
 * violations, coupling hubs and orphaned systems, computed from the same
 * overview the derivation renders. Ported from the systems overview — every
 * row focuses its system on the canvas.
 */
export function InsightsPanel({
  overview,
  onFocusSystem,
  onSelectEdge,
  onClose,
}: {
  overview: SystemOverview;
  /** Focus a system's node on the canvas (raw overview id). */
  onFocusSystem: (rawId: string) => void;
  /** Open a boundary in the contracts inspector (raw "source->target" key). */
  onSelectEdge: (key: string) => void;
  onClose: () => void;
}) {
  const insights = useMemo(() => computeSystemInsights(overview), [overview]);
  const nameOf = (id: string): string =>
    overview.systems.find((s) => s.id === id)?.name ?? id;

  const section = (title: string, count: number) => (
    <div className="flex items-center justify-between px-1.5 pb-1 pt-3 first:pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </span>
      <span className="text-[10px] text-ink-faint">{count}</span>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Insights
          {insights.total > 0 ? (
            <span className="rounded-full bg-warn/15 px-1.5 text-[9px] leading-4 normal-case tracking-normal text-warn">
              {insights.total}
            </span>
          ) : null}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close insights">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {insights.total === 0 && insights.hubs.length === 0 && insights.orphans.length === 0 ? (
          <EmptyState title="Nothing to flag">
            No cycles, layering violations, hubs or orphans in the current derivation.
          </EmptyState>
        ) : (
          <>
            {insights.cycles.length > 0 ? section("Dependency cycles", insights.cycles.length) : null}
            {insights.cycles.map((cycle, i) => (
              <div
                key={`cycle-${i}`}
                className="mb-1 rounded-lg border border-warn/30 bg-warn/5 px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 text-[10px] text-warn">
                  <RefreshCcwDot className="h-3 w-3 shrink-0" />
                  {cycle.ids.length} systems in a cycle
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {cycle.ids.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onFocusSystem(id)}
                      className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted hover:bg-surface-3 hover:text-ink"
                    >
                      {nameOf(id)}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {insights.violations.length > 0
              ? section("Layering violations", insights.violations.length)
              : null}
            {insights.violations.map((v, i) => (
              <Tooltip key={`v-${i}`} content={v.detail}>
                <button
                  type="button"
                  onClick={() => onSelectEdge(`${v.source}->${v.target}`)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  <AlertTriangle className="h-3 w-3 shrink-0 text-warn" />
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(v.source)} → {nameOf(v.target)}
                  </span>
                </button>
              </Tooltip>
            ))}

            {insights.hubs.length > 0 ? section("Coupling hubs", insights.hubs.length) : null}
            {insights.hubs.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => onFocusSystem(h.id)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                <Spline className="h-3 w-3 shrink-0 text-crystal-300" />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
                  {h.degree} links
                </span>
              </button>
            ))}

            {insights.orphans.length > 0 ? section("Orphans", insights.orphans.length) : null}
            {insights.orphans.map((o) => (
              <Tooltip key={o.id} content="No links in or out — dead weight or an island worth wiring">
                <button
                  type="button"
                  onClick={() => onFocusSystem(o.id)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  <CircleSlash2 className="h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-faint">{o.fileCount}f</span>
                </button>
              </Tooltip>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
