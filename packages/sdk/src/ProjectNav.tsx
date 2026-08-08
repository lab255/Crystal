import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, RotateCcw } from "lucide-react";
import type {
  ArchitectViewId,
  OrchestratorTabId,
  QualityViewId,
  SurfaceViewId,
} from "@crystal/core";
import { useNav, useNavUpdate, useSettings } from "@crystal/client";
import { cn, useContextMenu, type MenuEntry } from "@crystal/ui";
import {
  MODE_ICONS,
  MODE_LABELS,
  MODE_SUBSECTIONS,
  WORKSPACE_FACETS,
  orderedFacets,
  type CrystalMode,
} from "./modes.js";

/**
 * The project menu — second navigation level, inside the active workspace.
 * One section per facet (Architecture, Surfaces, Orchestrate, …) with its
 * deep-link subviews as subsections. Sections are drag-rearrangeable (order
 * persists in the settings store) and carry context menus; the active
 * section auto-expands, others toggle by chevron. The workspace panel
 * toggles (dev servers, git, terminal) live on the WorkspaceRail.
 */
export function ProjectNav({
  mode,
  runningRuns,
  needsYouCount,
  runningJobs,
  onSwitchMode,
}: {
  mode: CrystalMode;
  runningRuns: number;
  needsYouCount: number;
  runningJobs: number;
  onSwitchMode: (mode: CrystalMode) => void;
}) {
  const navOrder = useSettings((s) => s.navOrder);
  const setSettings = useSettings((s) => s.set);
  const updateNav = useNavUpdate();
  const menu = useContextMenu();
  // Primitive selectors only — object literals would re-render every nav tick.
  const archView = useNav((l) => l.architect?.view);
  const archLevel = useNav((l) => l.architect?.level);
  const surfView = useNav((l) => l.surfaces?.view);
  const orchTab = useNav((l) => l.orchestrate?.tab);
  const qualView = useNav((l) => l.quality?.view);
  const [manualOpen, setManualOpen] = useState<ReadonlySet<CrystalMode>>(new Set());
  const [dragId, setDragId] = useState<CrystalMode | null>(null);

  const order = orderedFacets(navOrder);

  const activeSubview = (m: CrystalMode): string | undefined => {
    const spec = MODE_SUBSECTIONS[m];
    if (!spec) return undefined;
    // The architecture view splits into its C4 altitudes in the nav.
    const current =
      m === "architect"
        ? archView === "architecture" || archView == null
          ? `architecture:${archLevel ?? "containers"}`
          : archView
        : m === "surfaces"
          ? surfView
          : m === "orchestrate"
            ? orchTab
            : qualView;
    return current ?? spec.default;
  };

  function openSubview(m: CrystalMode, id: string): void {
    switch (m) {
      case "architect": {
        const level = /^architecture:(\w+)$/.exec(id)?.[1];
        if (level) {
          // Scope cleared on purpose: the view lands on its own default
          // (components picks the biggest container).
          updateNav({
            mode: m,
            architect: {
              view: "architecture",
              level: level as "context" | "containers" | "components",
              scope: null,
            },
          });
        } else {
          updateNav({ mode: m, architect: { view: id as ArchitectViewId } });
        }
        break;
      }
      case "surfaces":
        updateNav({ mode: m, surfaces: { view: id as SurfaceViewId } });
        break;
      case "orchestrate":
        updateNav({ mode: m, orchestrate: { tab: id as OrchestratorTabId } });
        break;
      case "quality":
        updateNav({ mode: m, quality: { view: id as QualityViewId } });
        break;
      default:
        onSwitchMode(m);
    }
  }

  function move(m: CrystalMode, delta: number): void {
    const next = [...order];
    const i = next.indexOf(m);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= next.length) return;
    next.splice(i, 1);
    next.splice(j, 0, m);
    setSettings({ navOrder: next });
  }

  function drop(target: CrystalMode): void {
    if (!dragId || dragId === target) return;
    const next = order.filter((m) => m !== dragId);
    next.splice(next.indexOf(target) + (order.indexOf(dragId) < order.indexOf(target) ? 1 : 0), 0, dragId);
    setSettings({ navOrder: next });
  }

  function sectionMenu(e: React.MouseEvent, m: CrystalMode): void {
    const entries: MenuEntry[] = [
      {
        type: "item",
        label: "Move up",
        icon: ArrowUp,
        disabled: order.indexOf(m) === 0,
        onSelect: () => move(m, -1),
      },
      {
        type: "item",
        label: "Move down",
        icon: ArrowDown,
        disabled: order.indexOf(m) === order.length - 1,
        onSelect: () => move(m, 1),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Reset section order",
        icon: RotateCcw,
        disabled: navOrder.length === 0,
        onSelect: () => setSettings({ navOrder: [] }),
      },
    ];
    menu.open(e, entries);
  }

  const shortcutFor = (m: CrystalMode) => `Ctrl+${WORKSPACE_FACETS.indexOf(m) + 3}`;

  return (
    <nav
      aria-label="Project"
      className="flex w-44 min-h-0 shrink-0 flex-col border-r border-edge bg-surface-1"
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {order.map((m) => {
          const Icon = MODE_ICONS[m];
          const spec = MODE_SUBSECTIONS[m];
          const active = mode === m;
          const open = active || manualOpen.has(m);
          const badge =
            m === "orchestrate" ? needsYouCount || runningRuns : m === "jobs" ? runningJobs : 0;
          const badgeWarns = m === "orchestrate" && needsYouCount > 0;
          const sub = activeSubview(m);
          return (
            <div
              key={m}
              className={cn("px-1.5", dragId === m && "opacity-50")}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={() => drop(m)}
            >
              <div
                draggable
                onDragStart={() => setDragId(m)}
                onDragEnd={() => setDragId(null)}
                onContextMenu={(e) => sectionMenu(e, m)}
                className="group/navsec"
              >
                <button
                  type="button"
                  onClick={() => onSwitchMode(m)}
                  aria-pressed={active}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-crystal-500/15 text-crystal-300"
                      : "text-ink-muted hover:bg-surface-3 hover:text-ink",
                  )}
                  title={`${MODE_LABELS[m]} (${shortcutFor(m)})`}
                >
                  {spec ? (
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 text-ink-faint transition-transform",
                        open && "rotate-90",
                      )}
                      onClick={(e) => {
                        // The chevron toggles without navigating.
                        e.stopPropagation();
                        setManualOpen((s) => {
                          const next = new Set(s);
                          if (next.has(m)) next.delete(m);
                          else next.add(m);
                          return next;
                        });
                      }}
                    />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{MODE_LABELS[m]}</span>
                  {badge > 0 ? (
                    <span
                      className={cn(
                        "flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-bold text-surface-0",
                        badgeWarns ? "bg-warn" : "bg-info",
                      )}
                    >
                      {badge}
                    </span>
                  ) : null}
                </button>
              </div>
              {spec && open ? (
                <div className="mb-1 mt-0.5 flex flex-col">
                  {spec.items.map((item) => {
                    const subActive = active && sub === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openSubview(m, item.id)}
                        aria-pressed={subActive}
                        className={cn(
                          "flex h-6 items-center gap-1.5 rounded-md py-0 pl-8 pr-1.5 text-[11px] transition-colors",
                          subActive
                            ? "bg-crystal-500/10 font-medium text-crystal-300"
                            : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
                        )}
                      >
                        <span className="min-w-0 truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {menu.element}
    </nav>
  );
}
