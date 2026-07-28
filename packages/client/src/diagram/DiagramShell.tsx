import type { ReactNode } from "react";
import { Pane, Split, cn } from "@crystal/ui";

/**
 * Shared chrome for the three diagrams (architecture / codebase / infra).
 * Every view renders the same frame: a canvas with floating tool clusters —
 * top-left the primary toolbar (breadcrumb · find · lens chip · vs-ref ·
 * facet/selection chip · overlay/layout menus, in that order), top-right the
 * secondary cluster, bottom-left the legend — and an optional right side
 * panel in a persisted Split. The shell owns none of the state; it exists so
 * the three diagrams cannot drift apart in placement or styling.
 *
 * Deliberately react-flow-free: `client` sits below the mode packages, so
 * the canvas arrives as `children`.
 */
export function DiagramShell({
  toolbar,
  toolbarRight,
  legend,
  sidePanel,
  splitStorageKey,
  children,
  className,
}: {
  /** Top-left floating cluster. Slot order is the cross-view convention. */
  toolbar?: ReactNode;
  /** Top-right floating cluster (status, live pulse, view switches). */
  toolbarRight?: ReactNode;
  /** Bottom-left floating cluster (mark/edge legends). */
  legend?: ReactNode;
  /** Right pane content; null/undefined renders the canvas full-bleed. */
  sidePanel?: ReactNode;
  /** Split persistence key, e.g. "architect:codebase". */
  splitStorageKey: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="h-full min-h-0">
      <Split storageKey={splitStorageKey} direction="horizontal">
        <Pane minSize="40%">
          <div className={cn("relative h-full w-full min-w-0", className)}>
            {toolbar ? (
              <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5">
                {toolbar}
              </div>
            ) : null}
            {toolbarRight ? (
              <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                {toolbarRight}
              </div>
            ) : null}
            {legend ? <div className="absolute bottom-3 left-3 z-10">{legend}</div> : null}
            {children}
          </div>
        </Pane>
        {sidePanel != null ? (
          <Pane minSize={280} maxSize="45%">
            {sidePanel}
          </Pane>
        ) : null}
      </Split>
    </div>
  );
}

/** One floating tool cluster — the shared rounded card every control sits in. */
export function DiagramToolbarGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface DiagramLegendEntry {
  /** Swatch classes (bg/border tokens) — a 10px square. */
  swatchClassName: string;
  label: string;
}

/** The shared bottom-left legend card (diff marks, edge kinds, roles…). */
export function DiagramLegend({
  entries,
  className,
}: {
  entries: readonly DiagramLegendEntry[];
  className?: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-edge bg-surface-1/95 px-2.5 py-1.5 text-[10px] text-ink-muted shadow-sm backdrop-blur",
        className,
      )}
    >
      {entries.map((e) => (
        <span key={e.label} className="flex items-center gap-1.5">
          <span className={cn("h-2.5 w-2.5 rounded-sm", e.swatchClassName)} />
          {e.label}
        </span>
      ))}
    </div>
  );
}
