import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { cn } from "../cn.js";

export { Panel as SplitPanel, PanelGroup as SplitGroup };

export function SplitHandle({
  direction = "horizontal",
  className,
}: {
  direction?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <PanelResizeHandle
      className={cn(
        "group relative shrink-0 bg-edge transition-colors data-[resize-handle-state=drag]:bg-crystal-500",
        direction === "horizontal" ? "w-px" : "h-px",
        className,
      )}
    >
      <div
        className={cn(
          "absolute z-10 group-hover:bg-crystal-500/50",
          direction === "horizontal" ? "-left-1 -right-1 top-0 bottom-0" : "-top-1 -bottom-1 left-0 right-0",
        )}
      />
    </PanelResizeHandle>
  );
}
