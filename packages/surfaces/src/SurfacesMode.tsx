import { useEffect, useRef } from "react";
import {
  AppWindow,
  BookOpenText,
  Boxes,
  Component as ComponentIcon,
  Database,
  Maximize2,
  PanelsTopLeft,
  RefreshCw,
  Search,
  Waypoints,
  Webhook,
  X,
} from "lucide-react";
import type { SurfaceViewId } from "@crystal/core";
import { useNav, useNavUpdate } from "@crystal/client";
import { Pane as SplitPane, Split, Spinner, Tooltip, cn, useSidePaneLayout } from "@crystal/ui";
import { ArchPane } from "@crystal/architect";
import { ApiExplorer } from "./ApiExplorer.js";
import { ComponentsView } from "./ComponentsView.js";
import { SchemasView } from "./SchemasView.js";
import { ScreensView } from "./ScreensView.js";
import { StoriesView } from "./StoriesView.js";
import { SurfacesProvider, useArchHighlight, useSurfaces } from "./common.js";

/**
 * Surfaces — everything the product presents to the outside world, in one
 * place: the frontend's screens, components and stories (with live demos when
 * dev servers run) next to the backend's API routes and data schemas. Every
 * subview and selection is a deep link (`#/surfaces/<view>?…`).
 */

const VIEW_META: { id: SurfaceViewId; label: string; icon: typeof AppWindow }[] = [
  { id: "screens", label: "Screens", icon: AppWindow },
  { id: "components", label: "Components", icon: ComponentIcon },
  { id: "stories", label: "Stories", icon: BookOpenText },
  { id: "apis", label: "APIs", icon: Webhook },
  { id: "schemas", label: "Schemas", icon: Database },
];

export function SurfacesMode() {
  return (
    <SurfacesProvider>
      <SurfacesShell />
    </SurfacesProvider>
  );
}

function SurfacesShell() {
  const nav = useNavUpdate();
  // Screens are the mode's front door (the system map folded into the
  // architecture view; must match the deep-link codec's default or
  // refreshing the bare URL would switch views).
  const view = useNav((l) => l.surfaces?.view) ?? "screens";
  const find = useNav((l) => l.surfaces?.find) ?? "";
  const archOpen = useNav((l) => l.surfaces?.arch ?? false);
  const archPane = useSidePaneLayout();
  const { report, loading, error, refresh } = useSurfaces();
  const findRef = useRef<HTMLInputElement>(null);

  // Ctrl+F focuses the shared find box (browser find is useless on virtual
  // lists). Gated on the active mode — hidden-but-mounted modes must not
  // swallow the shortcut (same pattern as ArchitectMode).
  const activeMode = useNav((l) => l.mode) ?? "surfaces";
  useEffect(() => {
    if (activeMode !== "surfaces") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode]);

  // The map tab carries no count badge — it composes several surfaces at once.
  const counts: Partial<Record<SurfaceViewId, number>> = {
    screens: report?.screens.length ?? 0,
    components: report?.components.length ?? 0,
    stories: report?.stories.length ?? 0,
    apis: report?.endpoints.length ?? 0,
    schemas: report?.schemas.length ?? 0,
  };

  return (
    <Split storageKey="surfaces:arch-pane" direction="horizontal">
      <SplitPane minSize="30%">
        <div className="flex h-full min-h-0 flex-col bg-surface-0">
          <header className="flex h-10 shrink-0 items-center border-b border-edge bg-surface-1 px-3">
            <PanelsTopLeft className="mr-2 h-4 w-4 text-crystal-300" />
            <span className="text-[13px] font-semibold text-ink">Surfaces</span>
            <div className="ml-3 flex w-60 items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1">
              <Search className="h-3 w-3 shrink-0 text-ink-faint" />
              <input
                ref={findRef}
                value={find}
                onChange={(e) => nav({ surfaces: { find: e.target.value || null } })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    nav({ surfaces: { find: null } });
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder="Find in all surfaces…"
                aria-label="Find across screens, components, stories, APIs and schemas"
                className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
              />
              {find ? (
                <button
                  type="button"
                  onClick={() => nav({ surfaces: { find: null } })}
                  aria-label="Clear find"
                >
                  <X className="h-3 w-3 text-ink-faint hover:text-ink" />
                </button>
              ) : null}
            </div>
            <Tooltip content="Re-analyze the workspace">
              <button
                type="button"
                onClick={refresh}
                aria-label="Refresh surfaces"
                className="ml-2 rounded-md p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </button>
            </Tooltip>
            {(
              <Tooltip content="Toggle the architecture side pane — callers and integrations highlight there">
                <button
                  type="button"
                  onClick={() => nav({ surfaces: { arch: archOpen ? null : true } })}
                  aria-label="Toggle architecture pane"
                  aria-pressed={archOpen}
                  className={cn(
                    "rounded-md p-1 hover:bg-surface-3",
                    archOpen ? "text-crystal-300" : "text-ink-faint hover:text-ink",
                  )}
                >
                  <Boxes className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
            <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
              {VIEW_META.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => nav({ surfaces: { view: id } })}
                  aria-pressed={view === id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    view === id
                      ? "bg-surface-active text-ink"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  {(counts[id] ?? 0) > 0 ? (
                    <span
                      className={cn(
                        "rounded-full px-1 font-mono text-[9px]",
                        view === id ? "bg-crystal-500/20 text-crystal-300" : "text-ink-faint",
                      )}
                    >
                      {counts[id]}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            {loading && !report ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : error && !report ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div className="text-sm text-danger">Could not analyze this workspace</div>
                <div className="max-w-96 text-xs text-ink-muted">{error}</div>
                <button
                  type="button"
                  onClick={refresh}
                  className="mt-1 rounded-lg border border-edge bg-surface-2 px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink"
                >
                  Retry
                </button>
              </div>
            ) : view === "screens" ? (
              <ScreensView />
            ) : view === "components" ? (
              <ComponentsView />
            ) : view === "stories" ? (
              <StoriesView />
            ) : view === "apis" ? (
              <ApiExplorer appUrl={report?.demo.appUrl ?? null} />
            ) : (
              <SchemasView />
            )}
          </div>
        </div>
      </SplitPane>
      {archOpen ? (
        <SplitPane defaultSize={archPane.defaultSize} minSize={340} maxSize="70%">
          <ArchSidePane />
        </SplitPane>
      ) : null}
    </Split>
  );
}

/**
 * The embedded architecture systems view — callers/callees/integrations
 * clicked anywhere in surfaces highlight their node here (single click),
 * while double click / explicit "view in code" affordances navigate away.
 * Expandable to the full architecture view (selection carries over) and
 * dismissable; open state deep-links as `arch=1`.
 */
function ArchSidePane() {
  const nav = useNavUpdate();
  const arch = useArchHighlight();
  const { compact } = useSidePaneLayout();

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-edge bg-surface-0">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-2.5">
        <Boxes className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Architecture
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Tooltip content="Open the full architecture view (keeps this selection)">
            <button
              type="button"
              onClick={arch.expand}
              aria-label="Expand to the architecture view"
              className={cn(
                "rounded-md",
                // A half-width pane isn't on offer on compact screens, so the
                // route to the full view has to sell itself.
                compact
                  ? "flex items-center gap-1 border border-crystal-500/40 bg-crystal-500/10 px-1.5 py-0.5 text-[10px] font-medium text-crystal-300 hover:bg-crystal-500/20"
                  : "p-1 text-ink-faint hover:bg-surface-3 hover:text-ink",
              )}
            >
              <Maximize2 className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
              {compact ? "Expand" : null}
            </button>
          </Tooltip>
          <Tooltip content="Close the architecture pane">
            <button
              type="button"
              onClick={() => nav({ surfaces: { arch: null } })}
              aria-label="Close the architecture pane"
              className="rounded-md p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ArchPane />
      </div>
    </div>
  );
}
