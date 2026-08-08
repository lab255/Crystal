import { useCallback } from "react";
import { useStore } from "zustand";
import { AppWindow, Plus, X } from "lucide-react";
import { formatDeepLink, parseWsRef } from "@crystal/core";
import { openNewWindow, useCrystal, useFleetConnections } from "@crystal/client";
import { Tooltip, cn, useContextMenu } from "@crystal/ui";
import { MODE_LABELS } from "./modes.js";
import { tabsStore, type ShellTab, type TabsState } from "./tabs.js";

/**
 * The shell's tab row — hidden until a second tab exists (the header's +
 * button and this strip's + both open one). Clicking applies the tab's saved
 * deep link; middle-click closes; the context menu can promote a tab to a
 * real window.
 */
export function TabStrip() {
  const { navStore, fleet, selectWorkspace } = useCrystal();
  const tabs = useStore(tabsStore, (s: TabsState) => s.tabs);
  const activeId = useStore(tabsStore, (s: TabsState) => s.activeId);
  const connections = useFleetConnections();
  const menu = useContextMenu();

  const applyTab = useCallback(
    (tab: ShellTab) => {
      tabsStore.getState().activate(tab.id);
      const ref = tab.link.ws ? parseWsRef(tab.link.ws) : null;
      if (ref) {
        const conn = fleet.connection(ref.sid);
        if (
          conn?.workspaces.some((w) => w.id === ref.ws) &&
          (fleet.activeSid !== ref.sid || conn.activeWs !== ref.ws)
        ) {
          selectWorkspace(ref.sid, ref.ws);
        }
      }
      navStore.getState().apply({ ...tab.link });
    },
    [fleet, navStore, selectWorkspace],
  );

  const closeTab = useCallback(
    (id: string) => {
      const neighbor = tabsStore.getState().close(id);
      if (neighbor) applyTab(neighbor);
    },
    [applyTab],
  );

  if (tabs.length < 2) return null;

  const titleFor = (tab: ShellTab): string => {
    const mode = tab.link.mode ?? "projects";
    const label = MODE_LABELS[mode] ?? mode;
    const ref = tab.link.ws ? parseWsRef(tab.link.ws) : null;
    const wsName = ref
      ? connections
          .find((c) => c.sid === ref.sid)
          ?.workspaces.find((w) => w.id === ref.ws)?.name
      : null;
    return wsName ? `${wsName} · ${label}` : label;
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-edge bg-surface-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTab(t)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t.id);
              }}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    type: "item",
                    label: "Open in new window",
                    icon: AppWindow,
                    onSelect: () => {
                      const hash = formatDeepLink(t.link);
                      void openNewWindow(
                        `${window.location.pathname}${window.location.search}${hash}`,
                      );
                    },
                  },
                  { type: "separator" },
                  {
                    type: "item",
                    label: "Close tab",
                    danger: true,
                    onSelect: () => closeTab(t.id),
                  },
                ])
              }
              aria-pressed={active}
              className={cn(
                "group/tab flex h-5.5 min-w-0 max-w-48 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
                active
                  ? "bg-crystal-500/15 text-crystal-300"
                  : "text-ink-muted hover:bg-surface-3 hover:text-ink",
              )}
            >
              <span className="min-w-0 truncate">{titleFor(t)}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                className={cn(
                  "rounded p-0.5 text-ink-faint hover:bg-surface-active hover:text-danger",
                  active ? "" : "opacity-0 group-hover/tab:opacity-100",
                )}
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </button>
          );
        })}
      </div>
      <Tooltip content="New tab">
        <button
          type="button"
          aria-label="New tab"
          onClick={() => {
            const tab = tabsStore.getState().open({ mode: "projects" });
            applyTab(tab);
          }}
          className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      {menu.element}
    </div>
  );
}
