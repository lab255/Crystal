import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Badge, cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";

export const LeafNode = memo(function LeafNode({ data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const meta = KIND_META[arch.kind];
  const accent = accentOf(arch);
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        "min-w-40 max-w-56 rounded-lg border bg-surface-2/95 px-3 py-2 shadow-md shadow-black/30",
        "transition-shadow",
        selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
        <div className="truncate text-xs font-semibold text-ink">{arch.label}</div>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">{meta.label}</div>
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
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-none !bg-edge-strong" />
    </div>
  );
});
