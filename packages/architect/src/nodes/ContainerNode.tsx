import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";

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
        "h-full w-full rounded-xl border-[1.5px] transition-colors",
        selected ? "border-crystal-400" : "border-edge-strong",
      )}
      style={{
        background: `color-mix(in srgb, ${accent} 4%, var(--color-surface-1) 60%)`,
        borderStyle: arch.kind === "group" ? "dashed" : "solid",
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-crystal-400/60"
        handleClassName="!h-2 !w-2 !rounded-sm !border-none !bg-crystal-400"
      />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      <div
        className="arch-container-header flex cursor-grab items-center gap-1.5 rounded-t-[11px] border-b border-edge px-2.5 py-1.5 active:cursor-grabbing"
        style={{ background: `color-mix(in srgb, ${accent} 9%, transparent)` }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
        <span className="truncate text-xs font-semibold text-ink">{arch.label}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-ink-faint">
          {KIND_META[arch.kind].label}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-none !bg-edge-strong" />
    </div>
  );
});
