import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { FolderGit2, Power, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { Badge, Tooltip, cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";
import { fmtMs, fmtPct, fmtRps, type SimNodeStats } from "../simulation.js";
import { useSimActions } from "../SimPanel.js";

function SimStrip({ sim }: { sim: SimNodeStats }) {
  const u = sim.utilization;
  const barTone =
    u > 1 ? "bg-danger" : u > 0.7 ? "bg-warn" : "bg-ok";
  return (
    <div
      className={cn(
        "mt-1.5 rounded-md border px-1.5 py-1 font-mono text-[9px] leading-3",
        sim.overloaded ? "border-danger/40 bg-danger/5" : "border-edge bg-surface-1/60",
      )}
    >
      <div className="flex items-center justify-between gap-1 text-ink-muted">
        <span>{fmtRps(sim.inRps)} rps</span>
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
      {sim.cacheHitRate != null ? (
        <div className="mt-0.5 text-ink-faint">hit {fmtPct(sim.cacheHitRate)}</div>
      ) : null}
    </div>
  );
}

/** Breaker state pill + kill switch, shown while the simulation runs. */
function SimBadges({ id, sim, killed }: { id: string; sim: SimNodeStats; killed: boolean }) {
  const actions = useSimActions();
  return (
    <span className="nodrag absolute -right-2 -top-2 flex items-center gap-1">
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

export const LeafNode = memo(function LeafNode({ id, data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const meta = KIND_META[arch.kind];
  const accent = accentOf(arch);
  const Icon = meta.icon;
  const killed = data.simKilled === true;

  return (
    <div
      className={cn(
        "relative min-w-40 max-w-56 rounded-lg border bg-surface-2/95 px-3 py-2 shadow-md shadow-black/30",
        "transition-shadow",
        selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
        data.flow?.step === null && "opacity-30",
        data.sim?.overloaded && !killed && "border-danger/60 shadow-lg shadow-danger/20",
        killed && "opacity-40 saturate-0",
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
    >
      {data.flow != null && data.flow.step !== null ? (
        <span
          className="absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-crystal-500 px-1 font-mono text-[10px] font-bold text-white shadow-md"
          title={data.flow.step === 0 ? "Journey entry" : `Reached at hop ${data.flow.step}`}
        >
          {data.flow.step === 0 ? "▶" : data.flow.step}
        </span>
      ) : null}
      {data.sim ? <SimBadges id={id} sim={data.sim} killed={killed} /> : null}
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
        <div className="truncate text-xs font-semibold text-ink">{arch.label}</div>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
        {meta.label}
        {data.sim && (arch.sim?.replicas ?? 1) > 1 ? (
          <span className="ml-1 normal-case text-crystal-300">×{arch.sim!.replicas}</span>
        ) : null}
      </div>
      {arch.description ? (
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-muted">{arch.description}</div>
      ) : null}
      {arch.tech.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {arch.tech.slice(0, 4).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
          {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
        </div>
      ) : null}
      {data.sim ? <SimStrip sim={data.sim} /> : null}
      {data.code ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9.5px]",
            data.code.auto
              ? "border-dashed border-crystal-400/40 text-crystal-300/80"
              : "border-crystal-400/40 bg-crystal-500/10 text-crystal-300",
          )}
          title={data.code.auto ? "Suggested by name match — not saved yet" : "Linked code module"}
        >
          <FolderGit2 className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate font-mono">{data.code.module}</span>
          <span className="ml-auto shrink-0 opacity-70">{data.code.fileCount}f</span>
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-edge-strong" />
    </div>
  );
});
