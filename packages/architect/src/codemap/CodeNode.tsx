import { Handle, Position, type NodeProps, type Node as RfNode } from "@xyflow/react";
import { memo } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@crystal/ui";

export interface CodeNodeData extends Record<string, unknown> {
  title: string;
  subtitle?: string;
  accent: string;
  icon?: LucideIcon;
  badge?: string;
  /** Visual emphasis for the focused node at file level. */
  emphasis?: boolean;
  /** Rendered dashed — used for cross-module boundary nodes. */
  boundary?: boolean;
}

export type CodeRfNode = RfNode<CodeNodeData>;

export const CodeNode = memo(function CodeNode({ data, selected }: NodeProps<CodeRfNode>) {
  const Icon = data.icon;
  return (
    <div
      className={cn(
        "min-w-36 max-w-52 cursor-pointer rounded-lg border bg-surface-2/95 px-2.5 py-1.5 shadow-md shadow-black/25 transition-shadow",
        data.emphasis && "ring-2 ring-crystal-400/50",
        selected ? "border-crystal-400" : "border-edge-strong",
      )}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: data.accent,
        borderStyle: data.boundary ? "dashed" : "solid",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="h-3 w-3 shrink-0" style={{ color: data.accent }} /> : null}
        <span className="truncate text-[11.5px] font-semibold text-ink">{data.title}</span>
        {data.badge ? (
          <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
            {data.badge}
          </span>
        ) : null}
      </div>
      {data.subtitle ? (
        <div className="mt-0.5 truncate text-[9.5px] text-ink-faint">{data.subtitle}</div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
    </div>
  );
});
