import { useMemo, useState } from "react";
import { ChartColumn, MoveDownRight, MoveUpRight } from "lucide-react";
import {
  INSIGHT_PERIODS,
  buildUsageInsights,
  runCostUsd,
  usageTotalTokens,
  type AgentRun,
  type InsightDay,
  type InsightPeriod,
} from "@crystal/core";
import { useAgents } from "@crystal/client";
import { EmptyState, cn } from "@crystal/ui";
import { formatRunDuration, formatRunTokens } from "@crystal/client";
import { formatCost } from "./prompt.js";

/**
 * Usage insights — spend over time, computed entirely client-side from the
 * run list (one fold in @crystal/core insights.ts; period switches re-slice
 * locally, no refetch). Daily bars stack by model; tables below split the
 * window by model and purpose.
 */

export { INSIGHT_PERIODS, type InsightPeriod };

/**
 * Categorical series colors for models — validated (dataviz six checks)
 * against surface-1: lightness band, chroma, CVD + normal-vision separation,
 * contrast. Fixed assignment order; never cycled. Overflow folds into
 * "Other" (neutral), never a 6th hue.
 */
const SERIES_COLORS = ["#059669", "#8b7cf6", "#d97706", "#0891b2", "#e11d48"] as const;
const OTHER_COLOR = "#64748b";
const OTHER_KEY = "other";
const MAX_SERIES = SERIES_COLORS.length;

const CHART_HEIGHT = 148;
const GRID_LINES = [0.25, 0.5, 0.75, 1];

export function InsightsTab({
  period,
  onPeriodChange,
}: {
  period: InsightPeriod;
  onPeriodChange: (period: InsightPeriod) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const insights = useMemo(() => buildUsageInsights(runs, { days: period }), [runs, period]);

  // Color follows the model, never its rank in the current window: the
  // assignment derives from all-time spend, so switching periods (or a model
  // dropping out of the window) never repaints the survivors.
  const seriesByModel = useMemo(() => modelSeriesAssignment(runs), [runs]);

  const hasData = insights.totals.runCount > 0 || insights.prior.runCount > 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Usage insights</h2>
          <span className="text-[11px] text-ink-faint">
            computed locally from {runs.length} recorded runs
          </span>
          <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {INSIGHT_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                  period === p ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {p}d
              </button>
            ))}
          </div>
        </div>

        {!hasData ? (
          <EmptyState icon={ChartColumn} title="No runs in this window">
            Spend, tokens and run counts will chart here as agents work.
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              <StatTile
                label="Spend"
                value={formatCost(insights.totals.costUsd)}
                delta={deltaPct(insights.totals.costUsd, insights.prior.costUsd)}
              />
              <StatTile label="Tokens" value={formatRunTokens(insights.totals.tokens)} />
              <StatTile
                label="Runs"
                value={String(insights.totals.runCount)}
                delta={deltaPct(insights.totals.runCount, insights.prior.runCount)}
              />
              <StatTile
                label="Agent time"
                value={insights.totals.activeMs > 0 ? formatRunDuration(insights.totals.activeMs) : "—"}
              />
            </div>

            <SpendChart days={insights.days} seriesByModel={seriesByModel} />

            <div className="grid grid-cols-2 gap-3">
              <BreakdownTable
                title="By model"
                rows={Object.entries(insights.byModel).map(([key, slice]) => ({
                  key,
                  swatch: seriesByModel.get(key) ?? OTHER_COLOR,
                  ...slice,
                }))}
              />
              <BreakdownTable
                title="By purpose"
                rows={Object.entries(insights.byPurpose).map(([key, slice]) => ({
                  key,
                  ...slice,
                }))}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** All-time spend-ranked model → color assignment (top N models, rest fold to Other). */
function modelSeriesAssignment(runs: readonly AgentRun[]): Map<string, string> {
  const spend = new Map<string, number>();
  for (const run of runs) {
    const model = run.model ?? "unknown";
    spend.set(model, (spend.get(model) ?? 0) + runCostUsd(run) + usageTotalTokens(run.usage) / 1e9);
  }
  const ranked = [...spend.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const assignment = new Map<string, string>();
  ranked.slice(0, MAX_SERIES).forEach((model, i) => assignment.set(model, SERIES_COLORS[i]!));
  return assignment;
}

function deltaPct(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return ((current - prior) / prior) * 100;
}

function StatTile({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-ink">{value}</span>
        {delta != null && Number.isFinite(delta) ? (
          <span
            className="flex items-center gap-0.5 text-[10px] tabular-nums text-ink-muted"
            title="vs. the previous period"
          >
            {delta >= 0 ? <MoveUpRight className="h-2.5 w-2.5" /> : <MoveDownRight className="h-2.5 w-2.5" />}
            {Math.abs(delta) >= 100 ? Math.round(Math.abs(delta)) : Math.abs(delta).toFixed(0)}%
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Daily spend, stacked by model. HTML bars (not SVG): theme-native, and the
 * mark specs fall out of the box model — 2px surface gaps between stacked
 * segments and adjacent bars, rounded data-end on the top segment only.
 */
function SpendChart({
  days,
  seriesByModel,
}: {
  days: InsightDay[];
  seriesByModel: Map<string, string>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Hover-independent derivations — a mousemove across bars must not rebuild them.
  const { max, legend, labelEvery } = useMemo(() => {
    const max = Math.max(...days.map((d) => d.costUsd), 0.01);
    // Legend lists only models present in the window, in assignment order.
    const present = new Set(days.flatMap((d) => Object.keys(d.byModel)));
    const legend: { key: string; color: string }[] = [...seriesByModel.entries()]
      .filter(([model]) => present.has(model))
      .map(([model, color]) => ({ key: model, color }));
    if ([...present].some((m) => !seriesByModel.has(m))) {
      legend.push({ key: OTHER_KEY, color: OTHER_COLOR });
    }
    return { max, legend, labelEvery: Math.max(1, Math.ceil(days.length / 8)) };
  }, [days, seriesByModel]);
  const gridLines = GRID_LINES;
  const hovered = hover != null ? days[hover] : null;

  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-medium text-ink">Daily spend</span>
        {legend.length >= 2 ? (
          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            {legend.map(({ key, color }) => (
              <span key={key} className="flex items-center gap-1 text-[10px] text-ink-muted">
                <span className="h-2 w-2 rounded-[3px]" style={{ backgroundColor: color }} />
                {key}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="relative" style={{ height: CHART_HEIGHT + 18 }} onMouseLeave={() => setHover(null)}>
        {/* Recessive grid: hairlines across the plot, scale labels in a left
            gutter so tall bars can never occlude them. */}
        {gridLines.map((f) => (
          <div
            key={f}
            className="pointer-events-none absolute left-9 right-0 border-t border-edge/60"
            style={{ top: CHART_HEIGHT * (1 - f) }}
          >
            <span className="absolute -left-9 -top-1.5 w-8 text-right text-[9px] tabular-nums text-ink-faint">
              {formatCost(max * f)}
            </span>
          </div>
        ))}
        <div className="absolute left-9 right-0 top-0 flex items-end gap-[2px]" style={{ height: CHART_HEIGHT }}>
          {days.map((day, i) => {
            const total = day.costUsd;
            const barPx = total > 0 ? Math.max(3, (total / max) * CHART_HEIGHT) : 0;
            const segments = stackSegments(day, seriesByModel, barPx);
            return (
              <div
                key={day.date}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-stretch justify-end"
                onMouseEnter={() => setHover(i)}
              >
                {/* Full-height hit target (bigger than the mark). */}
                <div className={cn("absolute inset-0", hover === i && "bg-surface-3/40")} />
                <div className="relative flex flex-col-reverse gap-[2px]">
                  {segments.map((seg, j) => (
                    <div
                      key={seg.key}
                      style={{ height: seg.px, backgroundColor: seg.color }}
                      className={j === segments.length - 1 ? "rounded-t-[4px]" : undefined}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {/* X labels: sparse, under the baseline (nowrap — cells are narrower
            than a label, and sparseness leaves room to overflow). */}
        <div className="absolute left-9 right-0 flex gap-[2px]" style={{ top: CHART_HEIGHT + 4 }}>
          {days.map((day, i) => (
            <div
              key={day.date}
              className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[9px] text-ink-faint"
            >
              {i % labelEvery === 0 ? dayLabel(day.date) : ""}
            </div>
          ))}
        </div>
        {hovered ? (
          // Same left-9 frame as the bars, so percentage anchors line up.
          <div className="pointer-events-none absolute bottom-0 left-9 right-0 top-0">
            <ChartTooltip days={days} index={hover!} seriesByModel={seriesByModel} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Stack segments bottom-up in legend (assignment) order; overflow folds into Other. */
function stackSegments(
  day: InsightDay,
  seriesByModel: Map<string, string>,
  barPx: number,
): { key: string; color: string; px: number }[] {
  if (day.costUsd <= 0) return [];
  const entries = Object.entries(day.byModel);
  const named = [...seriesByModel.entries()]
    .map(([model, color]) => ({ key: model, color, cost: day.byModel[model]?.costUsd ?? 0 }))
    .filter((s) => s.cost > 0);
  const otherCost = entries
    .filter(([model]) => !seriesByModel.has(model))
    .reduce((sum, [, slice]) => sum + slice.costUsd, 0);
  const all = otherCost > 0 ? [...named, { key: OTHER_KEY, color: OTHER_COLOR, cost: otherCost }] : named;
  // Gaps are spacers, not data: subtract them before scaling so heights stay true.
  const gapPx = Math.max(0, (all.length - 1) * 2);
  const usable = Math.max(all.length, barPx - gapPx);
  return all.map((s) => ({ key: s.key, color: s.color, px: Math.max(1, (s.cost / day.costUsd) * usable) }));
}

function ChartTooltip({
  days,
  index,
  seriesByModel,
}: {
  days: InsightDay[];
  index: number;
  seriesByModel: Map<string, string>;
}) {
  const day = days[index]!;
  const onLeft = index > days.length / 2;
  const pct = (index + 0.5) / days.length;
  const rows = Object.entries(day.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-44 rounded-lg border border-edge-strong bg-surface-2 px-2.5 py-2 shadow-lg"
      style={onLeft ? { right: `${(1 - pct) * 100}%`, marginRight: 8 } : { left: `${pct * 100}%`, marginLeft: 8 }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium text-ink">{dayLabel(day.date)}</span>
        <span className="text-[10px] tabular-nums text-ink-muted">
          {formatCost(day.costUsd)} · {day.runCount} run{day.runCount === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {rows.map(([model, slice]) => (
            <div key={model} className="flex items-center gap-1.5 text-[10px] text-ink-muted">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: seriesByModel.get(model) ?? OTHER_COLOR }}
              />
              <span className="min-w-0 flex-1 truncate">{model}</span>
              <span className="tabular-nums">{formatCost(slice.costUsd)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-ink-faint">No spend this day.</div>
      )}
    </div>
  );
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; swatch?: string; costUsd: number; tokens: number; runCount: number }[];
}) {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  const total = sorted.reduce((sum, r) => sum + r.costUsd, 0);
  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-3">
      <div className="mb-1.5 text-[11px] font-medium text-ink">{title}</div>
      {sorted.length === 0 ? (
        <div className="py-2 text-[11px] text-ink-faint">Nothing in this window.</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-wider text-ink-faint">
              {/* w-full: the name column takes all slack, so `max-w-0 truncate`
                  on its cells ellipsizes instead of collapsing the column. */}
              <th className="w-full pb-1 font-semibold">&nbsp;</th>
              <th className="pb-1 pl-3 text-right font-semibold">Runs</th>
              <th className="pb-1 pl-3 text-right font-semibold">Tokens</th>
              <th className="pb-1 pl-3 text-right font-semibold">Spend</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.key} className="text-ink-muted">
                <td className="max-w-0 truncate py-0.5 pr-2">
                  <span className="flex items-center gap-1.5">
                    {row.swatch ? (
                      <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ backgroundColor: row.swatch }} />
                    ) : null}
                    <span className="truncate text-ink">{row.key}</span>
                  </span>
                </td>
                <td className="py-0.5 pl-3 text-right tabular-nums">{row.runCount}</td>
                <td className="py-0.5 pl-3 text-right tabular-nums">{formatRunTokens(row.tokens)}</td>
                <td className="py-0.5 pl-3 text-right tabular-nums">
                  {formatCost(row.costUsd)}
                  {total > 0 ? (
                    <span className="ml-1 text-ink-faint">
                      {Math.round((row.costUsd / total) * 100)}%
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
