import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, ClipboardCheck, Copy, Handshake, History, Layers, LayoutGrid, Lightbulb, Maximize2, Network, Radar, Rows3, TableProperties, Waypoints, X } from "lucide-react";
import type { ArchEdgeKind, ArchitectureGraph, CodeLodLevel } from "@crystal/core";
import { Button, Tooltip, cn } from "@crystal/ui";
import { EDGE_KIND_STYLE } from "./model.js";
import { LodSlider } from "./codemap/LodSlider.js";
import { CANVAS_LOD_LEVELS } from "./lod-config.js";

export function Toolbar({
  graph,
  facet,
  onExitFacet,
  defaultEdgeKind,
  onDefaultEdgeKindChange,
  onAutoLayout,
  singleAutoLayout,
  onFitView,
  onRename,
  lodLevel,
  onLodLevelChange,
  lodCounts,
  overlayOn,
  onToggleOverlay,
  showDuplicates,
  onToggleDuplicates,
  showFindings,
  onToggleFindings,
  showChanges,
  onToggleChanges,
  showInsights,
  onToggleInsights,
  showContracts,
  onToggleContracts,
  showScreens,
  onToggleScreens,
  showData,
  onToggleData,
  showEndpoints,
  onToggleEndpoints,
  onOpenWorkspacesMap,
  exportMenu,
}: {
  graph: ArchitectureGraph;
  /** Active facet lens, when one filters the canvas. */
  facet?: { name: string; shown: number; total: number; empty: boolean } | null;
  onExitFacet?: () => void;
  defaultEdgeKind: ArchEdgeKind;
  onDefaultEdgeKindChange: (kind: ArchEdgeKind) => void;
  onAutoLayout: (mode: "flow" | "layers") => void;
  /** C4 has one action: clear pins and reveal its already-solved ELK layout. */
  singleAutoLayout?: boolean;
  onFitView: () => void;
  onRename: (name: string) => void;
  /** Explicit detail ladder (packages → modules → members) over the whole canvas. */
  lodLevel?: CodeLodLevel;
  onLodLevelChange?: (level: CodeLodLevel) => void;
  lodCounts?: Partial<Record<CodeLodLevel, number>>;
  overlayOn?: boolean;
  onToggleOverlay?: (on: boolean) => void;
  showDuplicates?: boolean;
  onToggleDuplicates?: (on: boolean) => void;
  showFindings?: boolean;
  onToggleFindings?: (on: boolean) => void;
  showChanges?: boolean;
  onToggleChanges?: (on: boolean) => void;
  showInsights?: boolean;
  onToggleInsights?: (on: boolean) => void;
  showContracts?: boolean;
  onToggleContracts?: (on: boolean) => void;
  showScreens?: boolean;
  onToggleScreens?: (on: boolean) => void;
  /** Data-schema entities in the active C4 component boundary. */
  showData?: boolean;
  onToggleData?: (on: boolean) => void;
  /** Routes tier of the screens layer — called endpoints as their own nodes. */
  showEndpoints?: boolean;
  onToggleEndpoints?: (on: boolean) => void;
  /** Open the cross-workspace map (all open workspaces and their imports). */
  onOpenWorkspacesMap?: () => void;
  exportMenu?: ReactNode;
}) {
  const [name, setName] = useState(graph.name);
  useEffect(() => setName(graph.name), [graph.id, graph.name]);

  return (
    <div className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-edge bg-surface-2/95 py-1 pl-2.5 pr-1 shadow-xl shadow-black/30 backdrop-blur">
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
      <Tooltip content={singleAutoLayout ? "Auto layout" : "Auto-layout — flow (top to bottom)"}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onAutoLayout("flow")}
          aria-label={singleAutoLayout ? "Auto layout" : "Auto layout, flow"}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      {!singleAutoLayout ? (
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
      ) : null}
      <Tooltip content="Fit view">
        <Button variant="ghost" size="icon-sm" onClick={onFitView} aria-label="Fit view">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      {lodLevel && onLodLevelChange ? (
        <>
          <div className="h-4 w-px bg-edge" />
          <LodSlider
            level={lodLevel}
            onChange={onLodLevelChange}
            counts={lodCounts}
            levels={CANVAS_LOD_LEVELS}
          />
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
      {onToggleFindings ? (
        <Tooltip content="Review sweep — dead files, unused exports, duplicates, boundary leaks">
          <button
            type="button"
            aria-pressed={showFindings}
            onClick={() => onToggleFindings(!showFindings)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showFindings
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            review
          </button>
        </Tooltip>
      ) : null}
      {onToggleChanges ? (
        <Tooltip content="Recent edits from file timestamps — their wiring and blast radius (works without git)">
          <button
            type="button"
            aria-pressed={showChanges}
            onClick={() => onToggleChanges(!showChanges)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showChanges
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <History className="h-3.5 w-3.5" />
            Recent edits (file timestamps)
          </button>
        </Tooltip>
      ) : null}
      {onToggleScreens ? (
        <Tooltip content="Screens layer — frontend screens and their API call flows into the systems (the surfaces map, on this canvas)">
          <button
            type="button"
            aria-pressed={showScreens}
            onClick={() => onToggleScreens(!showScreens)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showScreens
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <AppWindow className="h-3.5 w-3.5" />
            screens
          </button>
        </Tooltip>
      ) : null}
      {onToggleData ? (
        <Tooltip content="Data schemas — entities and their in-scope references inside C4 components">
          <button
            type="button"
            aria-pressed={showData}
            onClick={() => onToggleData(!showData)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showData
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <TableProperties className="h-3.5 w-3.5" />
            Data
          </button>
        </Tooltip>
      ) : null}
      {onToggleEndpoints && showScreens ? (
        <Tooltip content="Routes tier — called endpoints as their own nodes, screen flows landing on the exact route">
          <button
            type="button"
            aria-pressed={showEndpoints}
            onClick={() => onToggleEndpoints(!showEndpoints)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showEndpoints
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <Waypoints className="h-3.5 w-3.5" />
            routes
          </button>
        </Tooltip>
      ) : null}
      {onToggleInsights ? (
        <Tooltip content="Insights — dependency cycles, layering violations, coupling hubs, orphans">
          <button
            type="button"
            aria-pressed={showInsights}
            onClick={() => onToggleInsights(!showInsights)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showInsights
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <Lightbulb className="h-3.5 w-3.5" />
            insights
          </button>
        </Tooltip>
      ) : null}
      {onToggleContracts ? (
        <Tooltip content="Contracts — every symbol crossing a system boundary, with import and call sites">
          <button
            type="button"
            aria-pressed={showContracts}
            onClick={() => onToggleContracts(!showContracts)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors",
              showContracts
                ? "bg-crystal-500/15 text-crystal-300"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            <Handshake className="h-3.5 w-3.5" />
            contracts
          </button>
        </Tooltip>
      ) : null}
      {onOpenWorkspacesMap ? (
        <Tooltip content="Workspaces map — all open workspaces and their cross-imports">
          <Button variant="ghost" size="icon-sm" onClick={onOpenWorkspacesMap} aria-label="Open workspaces map">
            <Network className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      ) : null}
      {exportMenu ? (
        <>
          <div className="h-4 w-px bg-edge" />
          {exportMenu}
        </>
      ) : null}
    </div>
  );
}
