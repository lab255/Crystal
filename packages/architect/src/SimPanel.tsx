import { createContext, useContext } from "react";
import { MarkerType, type Edge as RfEdge } from "@xyflow/react";
import { Flame, Gauge, Power, Repeat, ShieldAlert, ShieldCheck, Skull, Square, TriangleAlert, Zap } from "lucide-react";
import { Input, Switch, Tooltip, cn } from "@crystal/ui";
import {
  LB_ALGORITHMS,
  type ArchNode,
  type AutoscaleConfig,
  type LbAlgorithm,
  type SimNodeConfig,
} from "@crystal/core";
import {
  DEFAULT_MAX_BACKLOG,
  KIND_SIM_DEFAULTS,
  fmtMs,
  fmtPct,
  fmtRps,
  SPIKE_MULTIPLIER,
  type SimChaos,
  type SimNodeStats,
  type SimResult,
  type SimTotals,
} from "./simulation.js";

/**
 * Traffic-simulation UI, hosted by the infrastructure view: the control bar
 * (SimPanel), the per-node config form (SimEditor), and the decorations that
 * component cards and edges wear while a run is live.
 */

/** Actions node cards can trigger while the simulation runs. */
export const SimActionsContext = createContext<{
  /** Crash / restore a component (the per-node kill switch). */
  toggleKill: (id: string) => void;
  /** Take a whole deployment target down (or restore it if fully dead). */
  toggleKillTarget: (ids: string[]) => void;
} | null>(null);

export function useSimActions() {
  return useContext(SimActionsContext);
}

/** Traffic lens: edge width/label from simulated rps, colored by target health. */
export function applyTrafficToEdges<E extends RfEdge>(edges: E[], sim: SimResult): E[] {
  return edges.map((e) => {
    const rps = sim.edges.get(e.id);
    if (rps == null || rps < 0.5) {
      // No traffic: dependency edges, starved paths, dead branches.
      return { ...e, animated: false, style: { ...e.style, opacity: 0.25 } };
    }
    const target = sim.nodes.get(e.target);
    const failing = target != null && (target.down || target.breaker === "open");
    const stroke = failing
      ? "var(--color-danger)"
      : target?.overloaded
        ? "var(--color-warn)"
        : (e.style?.stroke as string | undefined);
    return {
      ...e,
      animated: !failing,
      label: `${fmtRps(rps)}/s`,
      style: {
        ...e.style,
        stroke,
        strokeWidth: 1.5 + Math.min(Math.log10(1 + rps), 3.5),
        opacity: 1,
      },
      labelStyle: { fill: stroke ?? "var(--color-ink-muted)", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Per-card decorations                                                */
/* ------------------------------------------------------------------ */

/** Compact live stats row + utilization bar, rendered inside a component card. */
export function SimStrip({ sim }: { sim: SimNodeStats }) {
  const u = sim.utilization;
  const barTone = u > 1 ? "bg-danger" : u > 0.7 ? "bg-warn" : "bg-ok";
  return (
    <div
      className={cn(
        "mt-1 rounded-md border px-1.5 py-1 font-mono text-[9px] leading-3",
        sim.overloaded ? "border-danger/40 bg-danger/5" : "border-edge bg-surface-1/60",
      )}
    >
      <div className="flex items-center justify-between gap-1 text-ink-muted">
        <span>{fmtRps(sim.inRps)} rps</span>
        {sim.replicas > 1 || sim.scaling ? (
          <span
            className={cn(sim.scaling ? "text-crystal-300" : "text-ink-faint")}
            title={
              sim.scaling === "up"
                ? "Autoscaler adding a replica"
                : sim.scaling === "down"
                  ? "Autoscaler removing a replica"
                  : `${sim.replicas} replicas`
            }
          >
            ×{sim.replicas}
            {sim.scaling === "up" ? "↑" : sim.scaling === "down" ? "↓" : ""}
          </span>
        ) : null}
        <span>{fmtMs(sim.latencyMs)}</span>
        <span className={cn(sim.errorRate > 0.02 && "text-danger")}>
          {fmtPct(sim.errorRate)} err
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-active">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barTone)}
          style={{ width: `${Math.min(u * 100, 100)}%` }}
        />
      </div>
      {sim.backlog != null && sim.maxBacklog != null ? (
        <>
          <div className="mt-0.5 flex items-center justify-between text-ink-faint">
            <span className={cn(sim.backlog >= sim.maxBacklog && "text-danger")}>
              backlog {fmtRps(sim.backlog)}
            </span>
            {sim.backlog > 1 ? (
              <span>
                {sim.servedRps > 0.5
                  ? `lag ${fmtMs((sim.backlog / sim.servedRps) * 1000)}`
                  : "stalled"}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-active">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                sim.backlog >= sim.maxBacklog ? "bg-danger" : "bg-crystal-400",
              )}
              style={{ width: `${Math.min((sim.backlog / sim.maxBacklog) * 100, 100)}%` }}
            />
          </div>
        </>
      ) : null}
      {sim.cacheHitRate != null ? (
        <div className="mt-0.5 text-ink-faint">hit {fmtPct(sim.cacheHitRate)}</div>
      ) : null}
    </div>
  );
}

/** Breaker state pill + kill switch, floated on a component card's corner. */
export function SimBadges({ id, sim, killed }: { id: string; sim: SimNodeStats; killed: boolean }) {
  const actions = useSimActions();
  return (
    <span className="nodrag absolute -right-2 -top-2 z-10 flex items-center gap-1">
      {sim.breaker && sim.breaker !== "closed" ? (
        <Tooltip
          content={
            sim.breaker === "open"
              ? "Circuit breaker OPEN — shedding all traffic while downstream recovers"
              : "Circuit breaker half-open — probing with a sliver of traffic"
          }
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-white shadow-md",
              sim.breaker === "open" ? "bg-danger" : "bg-warn",
            )}
          >
            <ShieldAlert className="h-3 w-3" />
          </span>
        </Tooltip>
      ) : sim.breaker === "closed" ? (
        <Tooltip content="Circuit breaker closed — traffic flowing normally">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-active text-ok shadow-md">
            <ShieldCheck className="h-3 w-3" />
          </span>
        </Tooltip>
      ) : null}
      <Tooltip content={killed ? "Crashed — click to restore" : "Chaos: crash this component"}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            actions?.toggleKill(id);
          }}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full shadow-md transition-colors",
            killed
              ? "bg-danger text-white"
              : "bg-surface-active text-ink-faint hover:bg-danger/20 hover:text-danger",
          )}
          aria-label={killed ? "Restore component" : "Crash component"}
          aria-pressed={killed}
        >
          {killed ? <Skull className="h-3 w-3" /> : <Power className="h-3 w-3" />}
        </button>
      </Tooltip>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Control bar                                                         */
/* ------------------------------------------------------------------ */

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

/** Last-ticks trend: ingress (faint) vs throughput (ok) — the gap is failures. */
function Sparkline({ history }: { history: SimTotals[] }) {
  const W = 92;
  const H = 24;
  if (history.length < 2) return <div style={{ width: W, height: H }} />;
  const max = Math.max(...history.map((t) => t.ingressRps), 1);
  const points = (f: (t: SimTotals) => number) =>
    history
      .map(
        (t, i) =>
          `${((i / (history.length - 1)) * W).toFixed(1)},${(H - 1.5 - (Math.max(f(t), 0) / max) * (H - 3)).toFixed(1)}`,
      )
      .join(" ");
  return (
    <Tooltip content="Recent ticks — ingress (faint) vs served throughput; the gap is failures">
      <svg width={W} height={H} className="shrink-0" role="img" aria-label="Traffic history">
        <polyline
          points={points((t) => t.ingressRps)}
          fill="none"
          stroke="var(--color-ink-faint)"
          strokeWidth="1"
          opacity="0.5"
        />
        <polyline
          points={points((t) => t.throughputRps)}
          fill="none"
          stroke="var(--color-ok)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </Tooltip>
  );
}

/** How many hints stack above the control bar before we cut the nagging off. */
const MAX_HINTS = 2;

export function SimPanel({
  result,
  history,
  ingressRps,
  onIngressChange,
  chaos,
  onChaosChange,
  killedCount,
  onRestoreAll,
  onStop,
}: {
  result: SimResult;
  history: SimTotals[];
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
  const retrying = chaos.retryStorm && totals.retryMultiplier > 1.05;

  return (
    <div className="flex flex-col items-center gap-1">
      {result.hints.slice(0, MAX_HINTS).map((hint) => (
        <div
          key={hint}
          className="flex items-center gap-1.5 rounded-lg border border-warn/30 bg-surface-2/95 px-2.5 py-1 text-[10px] text-warn shadow-lg backdrop-blur"
        >
          <TriangleAlert className="h-3 w-3 shrink-0" />
          {hint}
        </div>
      ))}
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
            {retrying ? (
              <span className="text-danger"> ×{totals.retryMultiplier.toFixed(1)} retries</span>
            ) : null}
          </span>
        </div>
        <Sparkline history={history} />
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
        <Tooltip content="Retry storm — clients retry every failure, so errors amplify next tick's traffic. Watch overload spiral.">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-ink-muted">
            <Repeat
              className={cn("h-3 w-3", chaos.retryStorm ? "text-danger" : "text-ink-faint")}
            />
            retries
            <Switch
              checked={chaos.retryStorm}
              onChange={(retryStorm) => onChaosChange({ ...chaos, retryStorm })}
              aria-label="Retry storm"
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

/* ------------------------------------------------------------------ */
/* Per-node config form                                                */
/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {children}
    </label>
  );
}

const selectClasses =
  "w-full h-8 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink " +
  "focus:border-crystal-500/60 focus:outline-none";

const DEFAULT_BREAKER = { enabled: true, errorThreshold: 0.5, cooldownTicks: 6 };
const DEFAULT_AUTOSCALE: AutoscaleConfig = {
  enabled: true,
  minReplicas: 1,
  maxReplicas: 10,
  targetUtilization: 0.7,
};

/** Traffic-simulation knobs; every field falls back to the kind default. */
export function SimEditor({
  node,
  onPatch,
}: {
  node: ArchNode;
  onPatch: (p: Partial<ArchNode>) => void;
}) {
  const defaults = KIND_SIM_DEFAULTS[node.kind];
  const sim = node.sim;
  const breaker = sim?.circuitBreaker;
  const autoscale = sim?.autoscale;

  const patchSim = (p: Partial<SimNodeConfig>) =>
    onPatch({ sim: { replicas: 1, ...(sim ?? {}), ...p } });

  const numberField = (
    label: string,
    value: number | null | undefined,
    placeholder: number | undefined,
    onCommit: (v: number | null) => void,
    opts?: { min?: number; step?: number },
  ) => (
    <Field label={label}>
      <Input
        type="number"
        min={opts?.min ?? 1}
        step={opts?.step ?? 1}
        value={value ?? ""}
        placeholder={placeholder != null ? String(placeholder) : undefined}
        onChange={(e) => {
          const v = e.target.value === "" ? null : Number(e.target.value);
          if (v == null || Number.isFinite(v)) onCommit(v);
        }}
      />
    </Field>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {numberField("Replicas", sim?.replicas === 1 ? null : sim?.replicas, 1, (v) =>
          patchSim({ replicas: Math.max(1, Math.round(v ?? 1)) }),
        )}
        {numberField("Capacity rps", sim?.capacityRps, defaults?.capacityRps, (v) =>
          patchSim({ capacityRps: v }),
        )}
      </div>
      {numberField("Base latency ms", sim?.latencyMs, defaults?.latencyMs, (v) =>
        patchSim({ latencyMs: v }), { min: 0 },
      )}
      {node.kind === "queue"
        ? numberField("Max backlog", sim?.maxBacklog, DEFAULT_MAX_BACKLOG, (v) =>
            patchSim({ maxBacklog: v }),
          )
        : null}
      {node.kind !== "external" ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Autoscale
            </span>
            <Switch
              checked={autoscale?.enabled ?? false}
              onChange={(enabled) =>
                patchSim({ autoscale: { ...DEFAULT_AUTOSCALE, ...(autoscale ?? {}), enabled } })
              }
              aria-label="Autoscale"
            />
          </div>
          {autoscale?.enabled ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {numberField("Min replicas", autoscale.minReplicas, undefined, (v) => {
                  const min = Math.max(1, Math.round(v ?? 1));
                  patchSim({
                    autoscale: {
                      ...autoscale,
                      minReplicas: min,
                      maxReplicas: Math.max(min, autoscale.maxReplicas),
                    },
                  });
                })}
                {numberField("Max replicas", autoscale.maxReplicas, undefined, (v) => {
                  const max = Math.max(1, Math.round(v ?? 1));
                  patchSim({
                    autoscale: {
                      ...autoscale,
                      maxReplicas: max,
                      minReplicas: Math.min(max, autoscale.minReplicas),
                    },
                  });
                })}
              </div>
              <Field label={`Target ${Math.round(autoscale.targetUtilization * 100)}% utilization`}>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={Math.round(autoscale.targetUtilization * 100)}
                  onChange={(e) =>
                    patchSim({
                      autoscale: { ...autoscale, targetUtilization: Number(e.target.value) / 100 },
                    })
                  }
                  className="h-1 w-full cursor-pointer"
                  style={{ accentColor: "var(--color-crystal-400)" }}
                />
              </Field>
            </>
          ) : null}
        </>
      ) : null}
      {node.kind === "loadbalancer" || node.kind === "gateway" ? (
        <Field label="Balancing algorithm">
          <select
            className={selectClasses}
            value={sim?.lbAlgorithm ?? "round-robin"}
            onChange={(e) => patchSim({ lbAlgorithm: e.target.value as LbAlgorithm })}
          >
            {LB_ALGORITHMS.map((a) => (
              <option key={a} value={a}>
                {a === "round-robin"
                  ? "Round robin (no health checks)"
                  : a === "least-loaded"
                    ? "Least loaded (health aware)"
                    : "Weighted by capacity (health aware)"}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {node.kind === "cache" ? (
        <Field label={`Hit rate — ${Math.round((sim?.cacheHitRate ?? defaults?.cacheHitRate ?? 0.85) * 100)}%`}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((sim?.cacheHitRate ?? defaults?.cacheHitRate ?? 0.85) * 100)}
            onChange={(e) => patchSim({ cacheHitRate: Number(e.target.value) / 100 })}
            className="h-1 w-full cursor-pointer"
            style={{ accentColor: "var(--color-crystal-400)" }}
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Circuit breaker
        </span>
        <Switch
          checked={breaker?.enabled ?? false}
          onChange={(enabled) =>
            patchSim({ circuitBreaker: { ...DEFAULT_BREAKER, ...(breaker ?? {}), enabled } })
          }
          aria-label="Circuit breaker"
        />
      </div>
      {breaker?.enabled ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Trip at ${Math.round(breaker.errorThreshold * 100)}% err`}>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(breaker.errorThreshold * 100)}
              onChange={(e) =>
                patchSim({
                  circuitBreaker: { ...breaker, errorThreshold: Number(e.target.value) / 100 },
                })
              }
              className="h-1 w-full cursor-pointer"
              style={{ accentColor: "var(--color-crystal-400)" }}
            />
          </Field>
          <Field label="Cooldown ticks">
            <Input
              type="number"
              min={1}
              value={breaker.cooldownTicks}
              onChange={(e) => {
                const v = Math.max(1, Math.round(Number(e.target.value)));
                if (Number.isFinite(v))
                  patchSim({ circuitBreaker: { ...breaker, cooldownTicks: v } });
              }}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
