import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, MoreHorizontal, Unplug } from "lucide-react";
import { Button, Input, Tooltip, cn, type MenuEntry } from "@crystal/ui";
import { ThreadRow } from "../ThreadRow.js";
import type { OverviewSection, OverviewThread } from "./overview-thread-model.js";

interface OverviewThreadRailProps {
  sections: OverviewSection[];
  selectedId: string | null;
  filter: "managers" | "all";
  hiddenCount: number;
  hasUnfilteredThreads: boolean;
  onFilter: (value: "managers" | "all") => void;
  find: string;
  onFind: (value: string) => void;
  onSelect: (id: string) => void;
  onPin: (key: string) => void;
  onNewProgram: () => void;
  entriesFor: (thread: OverviewThread) => MenuEntry[];
  headingEntriesFor: (section: OverviewSection) => MenuEntry[];
  openMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void;
}

interface EmptyStateContent {
  title: string;
  body: string;
  action: { label: string; run: () => void };
}

function emptyStateFor(
  filter: "managers" | "all",
  find: string,
  hiddenCount: number,
  hasUnfiltered: boolean,
  actions: { showAll: () => void; clear: () => void; create: () => void },
): EmptyStateContent {
  if (filter === "managers" && hiddenCount > 0) {
    return {
      title: "No manager threads",
      body: `${hiddenCount} other threads hidden by the Managers filter.`,
      action: { label: "Show all threads", run: actions.showAll },
    };
  }
  if (find.trim() && hasUnfiltered) {
    return {
      title: `No threads match '${find.trim()}'`,
      body: "Try another search or clear the current one.",
      action: { label: "Clear", run: actions.clear },
    };
  }
  return {
    title: filter === "managers" ? "No manager threads yet" : "No threads yet",
    body: "Starting a workflow in a project creates one.",
    action: { label: "New program", run: actions.create },
  };
}

/** The fleet rail makes filtered-out work explicit and keeps selection visible. */
export function OverviewThreadRail({
  sections,
  selectedId,
  filter,
  hiddenCount,
  hasUnfilteredThreads,
  onFilter,
  find,
  onFind,
  onSelect,
  onPin,
  onNewProgram,
  entriesFor,
  headingEntriesFor,
  openMenu,
}: OverviewThreadRailProps) {
  const rows = sections.flatMap((section) => section.threads);
  const rail = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const empty = emptyStateFor(filter, find, hiddenCount, hasUnfilteredThreads, {
    showAll: () => onFilter("all"),
    clear: () => onFind(""),
    create: onNewProgram,
  });

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    rail.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <aside
      ref={rail}
      className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1 outline-none"
    >
      <div className="space-y-2 border-b border-edge p-2">
        <div className="flex gap-1">
          <Input
            value={find}
            onChange={(event) => onFind(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && onFind("")}
            placeholder="Find threads…"
            aria-label="Find threads"
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <Tooltip content="New program">
            <Button variant="ghost" size="icon-sm" aria-label="New program" onClick={onNewProgram}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
        <div className="grid grid-cols-2 rounded-md bg-surface-2 p-0.5">
          {(["managers", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onFilter(value)}
              className={cn(
                "rounded px-2 py-1 text-[11px] capitalize",
                filter === value ? "bg-surface-3 font-medium text-ink" : "text-ink-muted",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div
        role="listbox"
        aria-label="Overview threads"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target instanceof HTMLInputElement
            || event.target instanceof HTMLTextAreaElement
          ) {
            return;
          }
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          const index = rows.findIndex((row) => row.id === selectedId);
          const next = event.key === "ArrowDown"
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1);
          if (rows[next]) onSelect(rows[next]!.id);
        }}
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {sections.map((section) => (
          <section
            key={section.kind === "coordinator" ? "coordinator" : section.key}
            role="group"
            aria-label={section.kind === "coordinator" ? "Coordinator" : section.name}
          >
            <div
              onContextMenu={(event) => openMenu(event, headingEntriesFor(section))}
              className={cn(
                "sticky top-0 z-10 flex w-full items-center gap-1 bg-surface-1",
                "px-2 py-1.5 text-left",
                "text-[10px] font-semibold uppercase tracking-wider text-ink-faint",
                section.kind === "workspace" && section.offline && "opacity-60",
              )}
            >
              {section.kind === "workspace" && section.offline ? (
                <Unplug className="h-3 w-3" />
              ) : null}
              <span>{section.kind === "coordinator" ? "Coordinator" : section.name}</span>
              <span className="font-normal text-ink-faint">· {section.threads.length}</span>
              {section.serverLabel ? (
                <span className="ml-auto normal-case tracking-normal">
                  {section.serverLabel}
                </span>
              ) : null}
              <button
                type="button"
                aria-label="Section actions"
                className="rounded p-0.5 text-ink-faint hover:text-ink"
                onClick={(event) => openMenu(event, headingEntriesFor(section))}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
            {section.kind === "coordinator" && section.serverLabel ? (
              <div className="px-2 pb-1 text-[10px] text-ink-faint">
                Programs on {section.serverLabel}
              </div>
            ) : null}
            {section.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                dataId={thread.id}
                thread={{
                  title: thread.title,
                  indicator: thread.indicator,
                  pinned: thread.pinned,
                  lastActivity: thread.lastActivity,
                  costUsd: thread.costUsd,
                  workerCount: thread.summary?.node.workers.length,
                }}
                selected={selectedId === thread.id}
                nowMs={nowMs}
                onSelect={() => onSelect(thread.id)}
                onTogglePin={() => onPin(thread.readKey)}
                onContextMenu={(event) => openMenu(event, entriesFor(thread))}
              />
            ))}
          </section>
        ))}
        {!rows.length ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs font-medium text-ink">{empty.title}</p>
            <p className="mt-1 text-[11px] text-ink-muted">{empty.body}</p>
            <Button className="mt-3" size="sm" onClick={empty.action.run}>
              {empty.action.label}
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
