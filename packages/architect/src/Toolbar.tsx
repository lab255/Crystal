import { useEffect, useState } from "react";
import { Copy, FolderGit2, Layers, LayoutGrid, Maximize2, Radar, Rows3, X, ZoomIn } from "lucide-react";
import type { ArchEdgeKind, ArchitectureGraph } from "@crystal/core";
import { Button, Tooltip, cn } from "@crystal/ui";
import { EDGE_KIND_STYLE } from "./model.js";
import { LOD_MIN_TEXT_RANGE, lodConfigStore, useLodConfig } from "./lod-config.js";

export function Toolbar({
  graph,
  facet,
  onExitFacet,
  defaultEdgeKind,
  onDefaultEdgeKindChange,
  onAutoLayout,
  onFitView,
  onRename,
  lodOn,
  onToggleLod,
  overlayOn,
  onToggleOverlay,
  showDuplicates,
  onToggleDuplicates,
  onOpenFullMap,
}: {
  graph: ArchitectureGraph;
  /** Active facet lens, when one filters the canvas. */
  facet?: { name: string; shown: number; total: number; empty: boolean } | null;
  onExitFacet?: () => void;
  defaultEdgeKind: ArchEdgeKind;
  onDefaultEdgeKindChange: (kind: ArchEdgeKind) => void;
  onAutoLayout: (mode: "flow" | "layers") => void;
  onFitView: () => void;
  onRename: (name: string) => void;
  lodOn?: boolean;
  onToggleLod?: (on: boolean) => void;
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
      {facet ? (
        <Tooltip
          content={
            facet.empty
              ? "This facet is empty — right-click nodes to add them; until then the whole diagram shows"
              : `Facet lens — showing ${facet.shown} of ${facet.total} nodes`
          }
        >
          <span className="flex h-6 items-center gap-1.5 rounded-md bg-crystal-500/20 pl-1.5 pr-0.5 text-[11px] text-crystal-300">
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-32 truncate font-medium">{facet.name}</span>
            <span className="text-crystal-300/70">
              {facet.empty ? "empty" : `${facet.shown}/${facet.total}`}
            </span>
            {onExitFacet ? (
              <button
                type="button"
                onClick={onExitFacet}
                className="rounded p-0.5 text-crystal-300/70 hover:bg-crystal-500/20 hover:text-crystal-200"
                aria-label="Show the whole diagram"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        </Tooltip>
      ) : null}
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
        <>
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
          {lodOn ? <LegibilitySlider /> : null}
        </>
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

/**
 * The one level-of-detail knob: the minimum on-screen text height (css px)
 * worth rendering. Chip grids collapse into their overview below it, and
 * zoom-driven expansion thresholds derive from it (see lod-config.ts).
 */
function LegibilitySlider() {
  const minTextPx = useLodConfig((s) => s.minTextPx);
  return (
    <Tooltip
      content={`Legibility threshold — words smaller than ${minTextPx}px on screen fold into the high-level overview`}
    >
      <span className="flex items-center gap-1 pr-1 text-[10px] tabular-nums text-ink-faint">
        <input
          type="range"
          min={LOD_MIN_TEXT_RANGE.min}
          max={LOD_MIN_TEXT_RANGE.max}
          step={0.5}
          value={minTextPx}
          onChange={(e) => lodConfigStore.getState().setMinTextPx(Number(e.target.value))}
          className="h-1 w-14 cursor-pointer accent-crystal-400"
          aria-label="Minimum legible text height in pixels"
        />
        {minTextPx}px
      </span>
    </Tooltip>
  );
}
