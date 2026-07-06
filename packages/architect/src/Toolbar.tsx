import { useEffect, useState } from "react";
import { Copy, FolderGit2, LayoutGrid, Maximize2, Play, Radar, Rows3, ZoomIn } from "lucide-react";
import type { ArchEdgeKind, ArchitectureGraph } from "@crystal/core";
import { Button, Tooltip, cn } from "@crystal/ui";
import { EDGE_KIND_STYLE } from "./model.js";

export function Toolbar({
  graph,
  defaultEdgeKind,
  onDefaultEdgeKindChange,
  onAutoLayout,
  onFitView,
  onRename,
  lodOn,
  onToggleLod,
  simOn,
  onToggleSim,
  overlayOn,
  onToggleOverlay,
  showDuplicates,
  onToggleDuplicates,
  onOpenFullMap,
}: {
  graph: ArchitectureGraph;
  defaultEdgeKind: ArchEdgeKind;
  onDefaultEdgeKindChange: (kind: ArchEdgeKind) => void;
  onAutoLayout: (mode: "flow" | "layers") => void;
  onFitView: () => void;
  onRename: (name: string) => void;
  lodOn?: boolean;
  onToggleLod?: (on: boolean) => void;
  simOn?: boolean;
  onToggleSim?: (on: boolean) => void;
  overlayOn?: boolean;
  onToggleOverlay?: (on: boolean) => void;
  showDuplicates?: boolean;
  onToggleDuplicates?: (on: boolean) => void;
  onOpenFullMap?: () => void;
}) {
  const [name, setName] = useState(graph.name);
  useEffect(() => setName(graph.name), [graph.id, graph.name]);

  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface-2/95 py-1 pl-2.5 pr-1 shadow-xl shadow-black/30 backdrop-blur">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== graph.name && onRename(name.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-40 bg-transparent text-[13px] font-semibold text-ink outline-none placeholder:text-ink-faint"
        placeholder="Untitled architecture"
        aria-label="Architecture name"
      />
      <div className="h-4 w-px bg-edge" />
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="New edge kind">
        {(Object.keys(EDGE_KIND_STYLE) as ArchEdgeKind[]).map((kind) => (
          <Tooltip key={kind} content={`New connections: ${EDGE_KIND_STYLE[kind].label}`}>
            <button
              type="button"
              role="radio"
              aria-checked={defaultEdgeKind === kind}
              onClick={() => onDefaultEdgeKindChange(kind)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] capitalize transition-colors",
                defaultEdgeKind === kind
                  ? "bg-surface-active text-ink"
                  : "text-ink-faint hover:text-ink-muted",
              )}
            >
              <span
                className="inline-block w-4"
                style={{
                  borderTop: `2px ${EDGE_KIND_STYLE[kind].dash ? "dashed" : "solid"} ${EDGE_KIND_STYLE[kind].stroke}`,
                }}
              />
              {kind}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="h-4 w-px bg-edge" />
      <Tooltip content="Auto-layout — flow (top to bottom)">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onAutoLayout("flow")}
          aria-label="Auto layout, flow"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Auto-layout — layers by role (controller → service → data; fullstack scopes run left-to-right)">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onAutoLayout("layers")}
          aria-label="Auto layout, layers"
        >
          <Rows3 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Fit view">
        <Button variant="ghost" size="icon-sm" onClick={onFitView} aria-label="Fit view">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      {onToggleLod ? (
        <Tooltip content="Dynamic detail — nodes expand into their code as you zoom in, and fold up as you zoom out">
          <button
            type="button"
            aria-pressed={lodOn}
            onClick={() => onToggleLod(!lodOn)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              lodOn ? "bg-crystal-500/20 text-crystal-300" : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <ZoomIn className="h-3.5 w-3.5" />
            detail
          </button>
        </Tooltip>
      ) : null}
      {onToggleSim ? (
        <Tooltip content="Simulate traffic — watch req/s flow through the design, then break it with chaos switches">
          <button
            type="button"
            aria-pressed={simOn}
            onClick={() => onToggleSim(!simOn)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              simOn ? "bg-ok/15 text-ok" : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <Play className={cn("h-3.5 w-3.5", simOn && "fill-current")} />
            simulate
          </button>
        </Tooltip>
      ) : null}
      {onToggleOverlay ? (
        <>
          <div className="h-4 w-px bg-edge" />
          <Tooltip content="Code overlay — compare this diagram against live imports from source">
            <button
              type="button"
              aria-pressed={overlayOn}
              onClick={() => onToggleOverlay(!overlayOn)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
                overlayOn
                  ? "bg-crystal-500/20 text-crystal-300"
                  : "text-ink-faint hover:text-ink-muted",
              )}
            >
              <Radar className="h-3.5 w-3.5" />
              code
            </button>
          </Tooltip>
        </>
      ) : null}
      {onToggleDuplicates ? (
        <Tooltip content="Duplicated functions — identical implementations across the workspace">
          <button
            type="button"
            aria-pressed={showDuplicates}
            onClick={() => onToggleDuplicates(!showDuplicates)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showDuplicates
                ? "bg-warn/15 text-warn"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <Copy className="h-3.5 w-3.5" />
            dupes
          </button>
        </Tooltip>
      ) : null}
      {onOpenFullMap ? (
        <Tooltip content="Full code map — every module and workspace, beyond this diagram">
          <Button variant="ghost" size="icon-sm" onClick={onOpenFullMap} aria-label="Open full code map">
            <FolderGit2 className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
