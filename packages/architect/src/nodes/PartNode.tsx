import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FolderTree } from "lucide-react";
import { cn } from "@crystal/ui";
import { highlightAttrs } from "../use-highlight.js";
import type { PartRfNode } from "../part-split.js";

/**
 * One part (directory unit) inside an expanded multi-part system. Ephemeral —
 * built from the overview, never persisted; boundary edges split onto these
 * cards along their part attribution.
 */
export const PartNode = memo(function PartNode({ data, selected }: NodeProps<PartRfNode>) {
  const { part } = data;
  const name = part.path.split("/").pop() || part.path;
  return (
    <div
      {...highlightAttrs({ module: part.pkg })}
      className={cn(
        "flex h-full w-full items-center gap-1.5 rounded-lg border bg-surface-2/95 px-2 shadow-sm",
        selected ? "border-crystal-400" : "border-edge-strong",
      )}
      title={part.path}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
      <FolderTree className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{name}</span>
      <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
        {part.fileCount}f
      </span>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
    </div>
  );
});
