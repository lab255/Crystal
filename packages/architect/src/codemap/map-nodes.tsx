import { Handle, Position, type NodeProps } from "@xyflow/react";
import { createContext, memo, useContext, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  MoveUpRight,
  Package,
  PackagePlus,
  Route,
} from "lucide-react";
import type { CodeSymbolKind, DiffMarkKind } from "@crystal/core";
import { Badge, Spinner, Tooltip, cn } from "@crystal/ui";
import { SymbolSnippet } from "../snippets.js";
import { highlightAttrs } from "../use-highlight.js";
import { SYMBOL_DRAG_MIME, type SymbolDragPayload } from "./CodeNode.js";
import type {
  DropTarget,
  FileNodeData,
  MapRfNode,
  ModuleNodeData,
  OverflowNodeData,
  SymbolNodeData,
} from "./map-model.js";

/** Kind → chip badge, shared with the FilePanel symbol list. */
export const SYMBOL_TONES: Record<
  CodeSymbolKind,
  { label: string; tone: "violet" | "cyan" | "emerald" | "amber" | "blue" | "rose" | "slate" | "neutral" }
> = {
  function: { label: "ƒ", tone: "blue" },
  component: { label: "⟨/⟩", tone: "cyan" },
  class: { label: "C", tone: "amber" },
  interface: { label: "I", tone: "emerald" },
  enum: { label: "E", tone: "rose" },
  type: { label: "T", tone: "violet" },
  const: { label: "•", tone: "slate" },
  default: { label: "d", tone: "neutral" },
  reexport: { label: "↪", tone: "neutral" },
};

/**
 * Handlers the nested map nodes need, provided once by the canvas instead of
 * being decorated onto every node's data (which would churn the scene memo).
 */
export interface MapActions {
  ws?: string;
  toggleModule(path: string): void;
  toggleFile(path: string): void;
  toggleCode(file: string, symbol: string): void;
  /** Show all / only the most connected files of a capped module (unified canvas). */
  toggleAllFiles?(nodeId: string): void;
  startJourney?(seed: { file: string; symbol: string }): void;
  /** HTML5 drop (FilePanel symbol drag) onto a file/module node. */
  dropSymbol(payload: SymbolDragPayload, target: DropTarget): void;
}

export const MapActionsContext = createContext<MapActions | null>(null);

function useMapActions(): MapActions {
  const ctx = useContext(MapActionsContext);
  if (!ctx) throw new Error("map nodes must render inside MapActionsContext");
  return ctx;
}

/** Shared HTML5 drop wiring for module containers and file cards. */
function useSymbolDrop(target: DropTarget, ownFile?: string) {
  const actions = useMapActions();
  const [dragOver, setDragOver] = useState(false);
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(SYMBOL_DRAG_MIME);
  return {
    dragOver,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      },
      onDragLeave: () => setDragOver(false),
      onDrop: (e: DragEvent) => {
        setDragOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const payload = JSON.parse(e.dataTransfer.getData(SYMBOL_DRAG_MIME)) as SymbolDragPayload;
          if (payload?.file && payload?.symbol && payload.file !== ownFile) {
            actions.dropSymbol(payload, target);
          }
        } catch {
          /* malformed drag payload — ignore */
        }
      },
    },
  };
}

function IntentBadge({ mark }: { mark: "source" | "target" }) {
  return (
    <span
      className="absolute -right-2 -top-2 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-warn text-surface-0 shadow"
      title={mark === "source" ? "A symbol moves out of here (draft)" : "A symbol moves in here (draft)"}
    >
      {mark === "source" ? <MoveUpRight className="h-2.5 w-2.5" /> : <PackagePlus className="h-2.5 w-2.5" />}
    </span>
  );
}

/* ---- ref-review (vs <ref>) mark styling, shared by module + file nodes ---- */

const DIFF_TONES: Record<
  DiffMarkKind,
  { label: string; badge: string; border: string }
> = {
  added: { label: "new", badge: "bg-ok/15 text-ok", border: "border-ok/70" },
  removed: { label: "removed", badge: "bg-danger/15 text-danger", border: "border-danger/70 border-dashed" },
  changed: { label: "changed", badge: "bg-warn/15 text-warn", border: "border-warn/70" },
};

function DiffBadge({ mark, detail }: { mark: DiffMarkKind; detail?: string }) {
  const tone = DIFF_TONES[mark];
  return (
    <Tooltip content={detail ?? `${tone.label} vs the review ref`}>
      <span className={cn("shrink-0 rounded-full px-1.5 text-[8.5px] leading-4", tone.badge)}>
        {tone.label}
      </span>
    </Tooltip>
  );
}

/* ---------------------------- module container ---------------------------- */

export const ModuleNode = memo(function ModuleNode({ data, selected }: NodeProps<MapRfNode>) {
  const d = data as ModuleNodeData;
  const actions = useMapActions();
  const { dragOver, props: dropProps } = useSymbolDrop({ module: d.path });

  return (
    <div
      className={cn(
        "relative h-full w-full rounded-xl border-[1.5px] transition-colors",
        selected ? "border-crystal-400" : d.diffMark ? DIFF_TONES[d.diffMark].border : "border-edge-strong",
        d.emphasis && "ring-2 ring-crystal-400/50",
        d.dimmed && "opacity-40",
        d.ghost && "opacity-60",
        dragOver && "ring-2 ring-warn",
      )}
      style={{ background: `color-mix(in srgb, ${d.accent} 5%, var(--color-surface-1) 55%)` }}
      {...highlightAttrs({ module: d.path })}
      {...dropProps}
    >
      {d.intentMark ? <IntentBadge mark={d.intentMark} /> : null}
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
      <div
        className="flex h-10 cursor-grab items-center gap-1.5 rounded-t-[11px] border-b border-edge px-2.5 active:cursor-grabbing"
        style={{ background: `color-mix(in srgb, ${d.accent} 10%, transparent)` }}
      >
        {!d.ghost ? (
          <button
            type="button"
            className="nodrag shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleModule(d.path);
            }}
            aria-label={`${d.expanded ? "Collapse" : "Expand"} ${d.name}`}
            title={d.expanded ? "Collapse module" : "Expand module — show its files"}
          >
            {d.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <Package className="h-3.5 w-3.5 shrink-0" style={{ color: d.accent }} />
        <span className="truncate text-xs font-semibold text-ink">{d.name}</span>
        {d.path !== "." ? (
          <span className="truncate font-mono text-[9px] text-ink-faint">{d.path}</span>
        ) : (
          <span className="text-[9px] text-ink-faint">workspace root</span>
        )}
        {d.loading ? <Spinner className="h-3 w-3 shrink-0" /> : null}
        <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
          {d.fileCount}f
        </span>
        {d.memberCount != null ? (
          <Tooltip content="Top-level members — functions, classes, types, constants">
            <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
              {d.memberCount}m
            </span>
          </Tooltip>
        ) : null}
        {d.truncated ? (
          <Tooltip content="Large module — showing the most connected files">
            <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-[9px] leading-4 text-warn">top</span>
          </Tooltip>
        ) : null}
        {d.diffMark ? <DiffBadge mark={d.diffMark} detail={d.diffDetail} /> : null}
      </div>
      {!d.expanded && !d.loading ? (
        <div className="px-2.5 py-1 text-[9.5px] text-ink-faint">
          {d.ghost ? "existed at the review ref" : "double-click to zoom in"}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
    </div>
  );
});

/* ------------------------------- file card -------------------------------- */

export const FileNode = memo(function FileNode({ data, selected }: NodeProps<MapRfNode>) {
  const d = data as FileNodeData;
  const actions = useMapActions();
  const { dragOver, props: dropProps } = useSymbolDrop({ module: d.module, file: d.path }, d.path);

  return (
    <div
      className={cn(
        "relative h-full w-full rounded-lg border bg-surface-2/95 shadow-md shadow-black/25 transition-shadow",
        d.planned
          ? "border-dashed border-warn/70 opacity-80"
          : d.moving
            ? "border-warn/70"
            : selected
              ? "border-crystal-400"
              : d.diffMark
                ? DIFF_TONES[d.diffMark].border
                : "border-edge-strong",
        d.emphasis && "ring-2 ring-crystal-400/50",
        d.dimmed && "opacity-40",
        d.ghost && "opacity-60",
        dragOver && "ring-2 ring-warn",
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: d.planned || d.moving ? "var(--color-warn)" : d.accent }}
      title={
        d.planned
          ? `Planned move from ${d.path} — apply the draft to execute`
          : d.moving
            ? `Pending move ${d.moveLabel} (draft)`
            : d.ghost
              ? `${d.path} — deleted since the review ref`
              : `${d.path} — drag onto another module to plan a file move`
      }
      {...highlightAttrs({ file: d.path, module: d.module })}
      {...dropProps}
    >
      {d.intentMark ? <IntentBadge mark={d.intentMark} /> : null}
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
      <div className={cn("flex items-center gap-1.5 px-2 pt-1.5", !d.expanded && "pb-1.5")}>
        {!d.planned && !d.ghost ? (
          <button
            type="button"
            className="nodrag shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleFile(d.path);
            }}
            aria-label={`${d.expanded ? "Collapse" : "Expand"} ${d.name}`}
            title={d.expanded ? "Collapse file" : "Expand file — show its symbols"}
          >
            {d.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : null}
        <FileCode2 className="h-3 w-3 shrink-0" style={{ color: d.planned || d.moving ? "var(--color-warn)" : d.accent }} />
        <span className="truncate text-[11.5px] font-semibold text-ink" title={d.path}>
          {d.name}
        </span>
        {d.loading ? <Spinner className="h-3 w-3 shrink-0" /> : null}
        {d.planned ? (
          <span className="ml-auto shrink-0 rounded-full bg-warn/15 px-1.5 text-[8.5px] leading-4 text-warn">
            planned
          </span>
        ) : d.moving ? (
          <span className="ml-auto shrink-0 truncate rounded-full bg-warn/15 px-1.5 text-[8.5px] leading-4 text-warn">
            {d.moveLabel}
          </span>
        ) : d.diffMark ? (
          <span className="ml-auto flex shrink-0">
            <DiffBadge mark={d.diffMark} />
          </span>
        ) : d.exportCount ? (
          <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
            {d.exportCount} exp
          </span>
        ) : null}
      </div>
      {d.expanded && d.overflow ? (
        <div className="absolute inset-x-2 bottom-1 truncate text-[9px] text-ink-faint">
          +{d.overflow} more — open the file panel for the full list
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
    </div>
  );
});

/* ------------------------------ symbol chip ------------------------------- */

export const SymbolNode = memo(function SymbolNode({ data, selected }: NodeProps<MapRfNode>) {
  const d = data as SymbolNodeData;
  const actions = useMapActions();
  const tone = SYMBOL_TONES[d.kind];
  const draggable = !d.planned && d.kind !== "reexport";

  return (
    <div
      className={cn(
        "group/sym relative h-full w-full rounded-md border bg-surface-1/95 text-[10.5px]",
        d.planned
          ? "border-dashed border-warn/70 opacity-80"
          : d.moving
            ? "border-warn/70"
            : selected
              ? "border-crystal-400"
              : "border-edge",
        d.dimmed && "opacity-40",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
      title={
        d.planned
          ? `Planned move from ${d.file} — apply the draft to execute`
          : d.moving
            ? `Pending move ${d.moveLabel} (draft)`
            : `${d.name} :${d.line}${draggable ? " — drag onto another file or module to plan a move" : ""}`
      }
      {...highlightAttrs({ file: d.file, symbol: d.name, module: d.module })}
    >
      <div className="flex h-7 items-center gap-1 px-1">
        <Badge tone={tone.tone} className="w-7 shrink-0 justify-center font-mono">
          {tone.label}
        </Badge>
        <span className={cn("min-w-0 flex-1 truncate font-mono", d.exported ? "text-ink" : "text-ink-muted")}>
          {d.name}
        </span>
        {d.planned ? (
          <span className="shrink-0 rounded-full bg-warn/15 px-1 text-[8.5px] leading-4 text-warn">planned</span>
        ) : d.moving ? (
          <span className="shrink-0 truncate rounded-full bg-warn/15 px-1 text-[8.5px] leading-4 text-warn">
            {d.moveLabel}
          </span>
        ) : (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/sym:opacity-100">
            {actions.startJourney && d.kind !== "reexport" && d.kind !== "default" ? (
              <button
                type="button"
                className="nodrag rounded p-0.5 text-ink-faint hover:text-crystal-300"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.startJourney!({ file: d.file, symbol: d.name });
                }}
                aria-label={`Start journey at ${d.name}`}
                title="Start journey here — trace this symbol's dataflow"
              >
                <Route className="h-3 w-3" />
              </button>
            ) : null}
            <button
              type="button"
              className={cn("nodrag rounded p-0.5 hover:text-ink", d.codeOpen ? "text-crystal-300" : "text-ink-faint")}
              onClick={(e) => {
                e.stopPropagation();
                actions.toggleCode(d.file, d.name);
              }}
              aria-label={`${d.codeOpen ? "Hide" : "Show"} source of ${d.name}`}
              title={d.codeOpen ? "Hide source" : "Show source"}
            >
              <Code2 className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      {d.codeOpen ? (
        <div className="nodrag nowheel absolute inset-x-1 bottom-1 top-7 overflow-auto rounded border border-edge bg-surface-0/80">
          <SymbolSnippet file={d.file} symbol={d.name} ws={actions.ws} className="max-h-none border-0" />
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------- capped-module overflow -------------------------- */

export const OverflowNode = memo(function OverflowNode({ data }: NodeProps<MapRfNode>) {
  const d = data as OverflowNodeData;
  const actions = useMapActions();
  const canToggle = actions.toggleAllFiles != null;

  return (
    <button
      type="button"
      disabled={!canToggle}
      className="nodrag flex h-full w-full items-center justify-center gap-1 rounded-lg border border-dashed border-edge-strong bg-surface-2/60 text-[10px] text-ink-faint transition-colors enabled:hover:border-crystal-400 enabled:hover:text-ink"
      onClick={(e) => {
        e.stopPropagation();
        actions.toggleAllFiles?.(d.nodeId);
      }}
      title={
        !canToggle
          ? `${d.hidden} files omitted from this large module`
          : d.showingAll
          ? "Show only the most connected files"
          : "Show every file in this module (files being refactored always stay visible)"
      }
    >
      {d.showingAll ? (
        <>
          <ChevronDown className="h-3 w-3 rotate-180" /> show fewer files
        </>
      ) : (
        <>
          <ChevronRight className="h-3 w-3" /> +{d.hidden} more files
        </>
      )}
    </button>
  );
});

export const mapNodeTypes = {
  codeModule: ModuleNode,
  codeFile: FileNode,
  codeSymbol: SymbolNode,
  codeOverflow: OverflowNode,
};
