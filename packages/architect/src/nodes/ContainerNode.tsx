import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Spinner, cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";
import { fmtRps } from "../simulation.js";

export const ContainerNode = memo(function ContainerNode({
  data,
  selected,
}: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const accent = accentOf(arch);
  const Icon = KIND_META[arch.kind].icon;

  return (
    <div
      className={cn(
        "relative h-full w-full rounded-xl border-[1.5px] transition-colors",
        selected ? "border-crystal-400" : "border-edge-strong",
        data.flow?.step === null && "opacity-30",
      )}
      style={{
        background: `color-mix(in srgb, ${accent} 4%, var(--color-surface-1) 60%)`,
        borderStyle: arch.kind === "group" ? "dashed" : "solid",
      }}
    >
      {data.flow != null && data.flow.step !== null ? (
        <span
          className="absolute -left-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-crystal-500 px-1 font-mono text-[10px] font-bold text-white shadow-md"
          title={data.flow.step === 0 ? "Journey entry" : `Reached at hop ${data.flow.step}`}
        >
          {data.flow.step === 0 ? "▶" : data.flow.step}
        </span>
      ) : null}
      <NodeResizer
        isVisible={selected && !data.codeExpanded}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-crystal-400/60"
        handleClassName="!h-2 !w-2 !rounded-sm !border-none !bg-crystal-400"
      />
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      <div
        className="arch-container-header flex cursor-grab items-center gap-1.5 rounded-t-[11px] border-b border-edge px-2.5 py-1.5 active:cursor-grabbing"
        style={{ background: `color-mix(in srgb, ${accent} 9%, transparent)` }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
        <span className="truncate text-xs font-semibold text-ink">{arch.label}</span>
        {data.codeExpanded ? (
          <span
            className="shrink-0 rounded-full bg-ok/15 px-1.5 text-[9px] leading-4 text-ok"
            title="Expanded into live code — derived from source, updates as code changes"
          >
            live
          </span>
        ) : null}
        {data.codeLoading ? <Spinner className="h-3 w-3 shrink-0" /> : null}
        {data.sim ? (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 font-mono text-[9px] leading-4",
              data.sim.overloaded ? "bg-danger/15 text-danger" : "bg-surface-active text-ink-muted",
            )}
            title="Simulated inbound traffic"
          >
            {fmtRps(data.sim.inRps)} rps
          </span>
        ) : null}
        {data.code ? (
          <span
            className={cn(
              "shrink-0 rounded-md border px-1 font-mono text-[9px] text-crystal-300",
              data.code.auto ? "border-dashed border-crystal-400/40 opacity-80" : "border-crystal-400/40 bg-crystal-500/10",
            )}
            title={data.code.auto ? "Suggested by name match — not saved yet" : "Linked code module"}
          >
            {data.code.module} · {data.code.fileCount}f
          </span>
        ) : null}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-ink-faint">
          {KIND_META[arch.kind].label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-edge-strong" />
    </div>
  );
});
