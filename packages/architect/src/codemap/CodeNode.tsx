import { Handle, Position, type NodeProps, type Node as RfNode } from "@xyflow/react";
import { memo, useState, type DragEvent } from "react";
import { MoveUpRight, PackagePlus, type LucideIcon } from "lucide-react";
import { cn } from "@crystal/ui";
import { SimBadges, SimStrip } from "../SimPanel.js";
import type { SimNodeStats } from "../simulation.js";

/** dataTransfer type for dragging a symbol out of the FilePanel. */
export const SYMBOL_DRAG_MIME = "application/x-crystal-symbol";

export interface SymbolDragPayload {
  file: string;
  symbol: string;
}

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
  /** Accept dropped symbols (draft plan drag-refactor); called with the payload. */
  onSymbolDrop?: (payload: SymbolDragPayload) => void;
  /** Pending refactor-intent marker: this node gives or receives a symbol. */
  intentMark?: "source" | "target";
  /** Live traffic stats while the infra simulation runs. */
  sim?: SimNodeStats;
  /** Component crashed via the sim kill switch. */
  simKilled?: boolean;
}

export type CodeRfNode = RfNode<CodeNodeData>;

export const CodeNode = memo(function CodeNode({ id, data, selected }: NodeProps<CodeRfNode>) {
  const Icon = data.icon;
  const [dragOver, setDragOver] = useState(false);
  const killed = data.simKilled === true;

  const accepts = (e: DragEvent) =>
    data.onSymbolDrop != null && e.dataTransfer.types.includes(SYMBOL_DRAG_MIME);

  return (
    <div
      className={cn(
        "relative min-w-36 max-w-52 cursor-pointer rounded-lg border bg-surface-2/95 px-2.5 py-1.5 shadow-md shadow-black/25 transition-shadow",
        data.emphasis && "ring-2 ring-crystal-400/50",
        selected ? "border-crystal-400" : "border-edge-strong",
        dragOver && "ring-2 ring-warn",
        data.sim?.overloaded && !killed && "border-danger/60 shadow-lg shadow-danger/20",
        killed && "opacity-40 saturate-0",
      )}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: data.accent,
        borderStyle: data.boundary ? "dashed" : "solid",
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const payload = JSON.parse(e.dataTransfer.getData(SYMBOL_DRAG_MIME)) as SymbolDragPayload;
          if (payload?.file && payload?.symbol) data.onSymbolDrop?.(payload);
        } catch {
          /* malformed drag payload — ignore */
        }
      }}
    >
      {data.intentMark ? (
        <span
          className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-warn text-surface-0 shadow"
          title={data.intentMark === "source" ? "A symbol moves out of here (draft)" : "A symbol moves in here (draft)"}
        >
          {data.intentMark === "source" ? (
            <MoveUpRight className="h-2.5 w-2.5" />
          ) : (
            <PackagePlus className="h-2.5 w-2.5" />
          )}
        </span>
      ) : null}
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
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
      {data.sim ? <SimStrip sim={data.sim} /> : null}
      {data.sim ? <SimBadges id={id} sim={data.sim} killed={killed} /> : null}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
    </div>
  );
});
