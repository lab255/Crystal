import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Unplug } from "lucide-react";
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

/** The fleet rail makes filtered-out work explicit and keeps selection visible. */
export function OverviewThreadRail({
  sections, selectedId, filter, hiddenCount, hasUnfilteredThreads, onFilter, find, onFind, onSelect,
  onPin, onNewProgram, entriesFor, headingEntriesFor, openMenu,
}: OverviewThreadRailProps) {
  const rows = sections.flatMap((section) => section.threads);
  const rail = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

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
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          const index = rows.findIndex((row) => row.id === selectedId);
          if (event.key === "Enter") {
            if (index >= 0) onSelect(rows[index]!.id);
            return;
          }
          const next = event.key === "ArrowDown"
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1);
          if (rows[next]) onSelect(rows[next]!.id);
        }}
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {sections.map((section) => (
          <section key={section.kind === "coordinator" ? "coordinator" : section.key}>
            <button
              type="button"
              onContextMenu={(event) => openMenu(event, headingEntriesFor(section))}
              className={cn(
                "sticky top-0 z-10 flex w-full items-center gap-1 bg-surface-1 px-2 py-1.5 text-left",
                "text-[10px] font-semibold uppercase tracking-wider text-ink-faint",
                section.kind === "workspace" && section.offline && "opacity-60",
              )}
            >
              {section.kind === "workspace" && section.offline ? <Unplug className="h-3 w-3" /> : null}
              {section.kind === "coordinator" ? "Coordinator" : section.name}
              {section.serverLabel ? (
                <span className="ml-auto normal-case tracking-normal">{section.serverLabel}</span>
              ) : null}
            </button>
            <div className="space-y-0.5">
              {section.threads.map((thread) => (
                <div key={thread.id} data-thread-id={thread.id}>
                  <ThreadRow
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
                </div>
              ))}
            </div>
          </section>
        ))}
        {!rows.length ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs font-medium text-ink">
              {filter === "managers" && hiddenCount > 0
                ? "No manager threads"
                : find.trim() && hasUnfilteredThreads
                  ? `No threads match '${find.trim()}'`
                  : filter === "managers" ? "No manager threads yet" : "No threads yet"}
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">
              {filter === "managers" && hiddenCount > 0
                ? `${hiddenCount} other threads hidden by the Managers filter.`
                : find.trim() && hasUnfilteredThreads
                  ? "Try another search or clear the current one."
                : "Starting a workflow in a project creates one."}
            </p>
            {filter === "managers" && hiddenCount > 0 ? (
              <Button className="mt-3" size="sm" onClick={() => onFilter("all")}>Show all threads</Button>
            ) : find.trim() && hasUnfilteredThreads ? (
              <Button className="mt-3" size="sm" onClick={() => onFind("")}>Clear</Button>
            ) : (
              <Button className="mt-3" size="sm" onClick={onNewProgram}>New program</Button>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
