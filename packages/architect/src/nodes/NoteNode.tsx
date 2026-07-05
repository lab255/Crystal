import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { cn } from "@crystal/ui";
import type { ArchRfNode } from "../model.js";

export const NoteNode = memo(function NoteNode({ data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  return (
    <div
      className={cn(
        "max-w-52 rounded-md border px-3 py-2 shadow-md shadow-black/20",
        "bg-accent-amber/10 text-[11px] leading-relaxed text-ink",
        selected ? "border-crystal-400" : "border-accent-amber/30",
      )}
    >
      <div className="font-medium">{arch.label}</div>
      {arch.description ? <div className="mt-1 text-ink-muted">{arch.description}</div> : null}
    </div>
  );
});
