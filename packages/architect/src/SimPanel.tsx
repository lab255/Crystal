import { createContext, useContext } from "react";
import { Flame, Gauge, Square, TriangleAlert, Zap } from "lucide-react";
import { Switch, Tooltip, cn } from "@crystal/ui";
import {
  fmtMs,
  fmtPct,
  fmtRps,
  SPIKE_MULTIPLIER,
  type SimChaos,
  type SimResult,
} from "./simulation.js";

/** Actions node cards can trigger while the simulation runs. */
export const SimActionsContext = createContext<{
  /** Crash / restore a component (the per-node kill switch). */
  toggleKill: (id: string) => void;
} | null>(null);

export function useSimActions() {
  return useContext(SimActionsContext);
}

/** Ingress slider is logarithmic: 0..100 ⇄ 1..50k rps. */
const SLIDER_MAX = 100;
const RPS_MAX_EXP = Math.log10(50_000);

export function sliderToRps(value: number): number {
  return Math.round(10 ** ((value / SLIDER_MAX) * RPS_MAX_EXP));
}

export function rpsToSlider(rps: number): number {
  return Math.round((Math.log10(Math.max(rps, 1)) / RPS_MAX_EXP) * SLIDER_MAX);
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  return (
    <div className="flex flex-col items-center px-1.5">
      <span
        className={cn(
          "font-mono text-[13px] font-semibold leading-4",
          tone === "default" && "text-ink",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-ink-faint">{label}</span>
    </div>
  );
}

export function SimPanel({
  result,
  ingressRps,
  onIngressChange,
  chaos,
  onChaosChange,
  killedCount,
  onRestoreAll,
  onStop,
}: {
  result: SimResult;
  ingressRps: number;
  onIngressChange: (rps: number) => void;
  chaos: SimChaos;
  onChaosChange: (chaos: SimChaos) => void;
  killedCount: number;
  onRestoreAll: () => void;
  onStop: () => void;
}) {
  const { totals } = result;
  const errTone = totals.errorRate > 0.2 ? "danger" : totals.errorRate > 0.02 ? "warn" : "ok";

  return (
    <div className="flex flex-col items-center gap-1">
      {result.hints.length > 0 ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-warn/30 bg-surface-2/95 px-2.5 py-1 text-[10px] text-warn shadow-lg backdrop-blur">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          {result.hints[0]}
        </div>
      ) : null}
      <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/95 py-1.5 pl-3 pr-1.5 shadow-xl shadow-black/30 backdrop-blur">
        <Gauge className="h-4 w-4 shrink-0 text-crystal-300" />
        <div className="flex flex-col">
          <input
            type="range"
            min={0}
            max={SLIDER_MAX}
            value={rpsToSlider(ingressRps)}
            onChange={(e) => onIngressChange(sliderToRps(Number(e.target.value)))}
            className="h-1 w-32 cursor-pointer"
            style={{ accentColor: "var(--color-crystal-400)" }}
            aria-label="Ingress traffic (requests per second)"
          />
          <span className="mt-0.5 text-center font-mono text-[9px] text-ink-faint">
            {fmtRps(ingressRps)} rps in{chaos.spike ? ` ×${SPIKE_MULTIPLIER}` : ""}
          </span>
        </div>
        <div className="h-6 w-px bg-edge" />
        <Metric label="through" value={`${fmtRps(totals.throughputRps)}/s`} />
        <Metric label="errors" value={fmtPct(totals.errorRate)} tone={errTone} />
        <Metric label="latency" value={fmtMs(totals.avgLatencyMs)} />
        {totals.cacheHitRate != null ? (
          <Metric
            label="cache hit"
            value={fmtPct(totals.cacheHitRate)}
            tone={totals.cacheHitRate < 0.2 ? "warn" : "default"}
          />
        ) : null}
        <div className="h-6 w-px bg-edge" />
        <Tooltip content={`Traffic spike — multiply ingress ×${SPIKE_MULTIPLIER}`}>
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-ink-muted">
            <Zap className={cn("h-3 w-3", chaos.spike ? "text-warn" : "text-ink-faint")} />
            spike
            <Switch
              checked={chaos.spike}
              onChange={(spike) => onChaosChange({ ...chaos, spike })}
              aria-label="Traffic spike"
            />
          </label>
        </Tooltip>
        <Tooltip content="Cache-miss storm — every cache misses; the full load hits your datastores">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-ink-muted">
            <Flame
              className={cn("h-3 w-3", chaos.cacheMissStorm ? "text-danger" : "text-ink-faint")}
            />
            miss storm
            <Switch
              checked={chaos.cacheMissStorm}
              onChange={(cacheMissStorm) => onChaosChange({ ...chaos, cacheMissStorm })}
              aria-label="Cache-miss storm"
            />
          </label>
        </Tooltip>
        {killedCount > 0 ? (
          <button
            type="button"
            onClick={onRestoreAll}
            className="rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/25"
          >
            revive {killedCount} dead
          </button>
        ) : null}
        <div className="h-6 w-px bg-edge" />
        <Tooltip content="Stop simulation">
          <button
            type="button"
            onClick={onStop}
            className="flex h-6 items-center gap-1.5 rounded-md bg-danger/15 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger/25"
          >
            <Square className="h-3 w-3 fill-current" />
            stop
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
