import { useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, Bot, Coins, Cpu, Gauge } from "lucide-react";
import { buildUsageInsights, formatUsd, type AgentRun } from "@crystal/core";
import { useFleet, useNavUpdate } from "@crystal/client";
import { cn } from "@crystal/ui";

/**
 * Fleet-wide agent pulse on the Overview — the insights + costs headline
 * pulled up from the orchestrator tabs. Derived entirely client-side from the
 * fleet store's run lists (same fold the Insights tab uses), so it costs no
 * bridge round-trip. Tiles jump into the active workspace's Costs / Insights
 * tabs for the full breakdown.
 */
export function FleetPulse() {
  const runsByWs = useFleet((s) => s.runsByWs);
  const updateNav = useNavUpdate();

  const { totals, prior, running, week } = useMemo(() => {
    const all: AgentRun[] = Object.values(runsByWs).flat();
    const week = buildUsageInsights(all, { days: 7 });
    return {
      totals: week.totals,
      prior: week.prior,
      running: all.filter((r) => r.status === "running").length,
      week,
    };
  }, [runsByWs]);

  if (totals.runCount === 0 && running === 0) return null;

  const trend =
    prior.costUsd > 0 ? (totals.costUsd - prior.costUsd) / prior.costUsd : null;

  const tile = (opts: {
    icon: React.ReactNode;
    label: string;
    value: string;
    detail?: React.ReactNode;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={opts.onClick}
      className="flex min-w-36 flex-1 flex-col gap-0.5 rounded-panel border border-edge bg-surface-1 px-3 py-2 text-left transition-colors hover:border-edge-strong hover:bg-surface-2"
    >
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {opts.icon}
        {opts.label}
      </span>
      <span className="text-base font-semibold tabular-nums text-ink">{opts.value}</span>
      {opts.detail ? <span className="text-[11px] text-ink-muted">{opts.detail}</span> : null}
    </button>
  );

  return (
    <div className="mb-5 flex flex-wrap gap-3">
      {tile({
        icon: <Coins className="h-3 w-3" />,
        label: "Agent spend · 7d",
        value: formatUsd(totals.costUsd),
        detail:
          trend !== null ? (
            <span className={cn("flex items-center gap-0.5", trend > 0 ? "text-warn" : "text-ok")}>
              {trend > 0 ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {Math.abs(trend * 100).toFixed(0)}% vs prior week
            </span>
          ) : (
            "no prior-week baseline"
          ),
        onClick: () => updateNav({ mode: "orchestrate", orchestrate: { tab: "costs" } }),
      })}
      {tile({
        icon: <Bot className="h-3 w-3" />,
        label: "Runs · 7d",
        value: String(totals.runCount),
        detail: `${(totals.tokens / 1_000_000).toFixed(totals.tokens >= 1_000_000 ? 1 : 2)}M tokens`,
        onClick: () => updateNav({ mode: "orchestrate", orchestrate: { tab: "insights" } }),
      })}
      {tile({
        icon: <Cpu className="h-3 w-3" />,
        label: "Active now",
        value: String(running),
        detail: running > 0 ? "agents running across the fleet" : "all quiet",
        onClick: () => updateNav({ mode: "orchestrate", orchestrate: { tab: "runs" } }),
      })}
      {tile({
        icon: <Gauge className="h-3 w-3" />,
        label: "Today",
        value: formatUsd(week.days[week.days.length - 1]?.costUsd ?? 0),
        detail: `${week.days[week.days.length - 1]?.runCount ?? 0} runs`,
        onClick: () => updateNav({ mode: "orchestrate", orchestrate: { tab: "insights" } }),
      })}
    </div>
  );
}
