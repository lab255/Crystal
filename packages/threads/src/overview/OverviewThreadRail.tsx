import { useEffect, useState } from "react";
import { GitBranchPlus, MessageSquarePlus, MoreHorizontal, Plus, Unplug } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  cn,
  type MenuEntry,
} from "@crystal/ui";
import { ThreadRow } from "../ThreadRow.js";
import type { OverviewSection, OverviewThread } from "./overview-thread-model.js";
import { useRovingListbox } from "../use-roving-listbox.js";
import { threadFailureTitle } from "../thread-model.js";

interface OverviewThreadRailProps {
  sections: OverviewSection[];
  selectedId: string | null;
  filter: "managers" | "all";
  hiddenCount: number;
  hasUnfilteredThreads: boolean;
  managerCount: number;
  allCount: number;
  hubLoaded: boolean;
  hubError: string | null;
  onRetryHub: () => void;
  onClearSelection: () => void;
  onFilter: (value: "managers" | "all") => void;
  find: string;
  onFind: (value: string) => void;
  onSelect: (id: string) => void;
  onPin: (key: string) => void;
  onNewProgram: () => void;
  onNewThread: () => void;
  onFocusComposer: () => void;
  entriesFor: (thread: OverviewThread) => MenuEntry[];
  headingEntriesFor: (section: OverviewSection) => MenuEntry[];
  openMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void;
}

interface EmptyStateContent {
  title: string;
  body: string;
  action: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
}

function emptyStateFor(
  filter: "managers" | "all",
  find: string,
  hiddenCount: number,
  hasUnfiltered: boolean,
  actions: { showAll: () => void; clear: () => void; createProgram: () => void; createThread: () => void },
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
    action: { label: "New thread", run: actions.createThread },
    secondary: { label: "New program", run: actions.createProgram },
  };
}

/** The fleet rail makes filtered-out work explicit and keeps selection visible. */
export function OverviewThreadRail({
  sections,
  selectedId,
  filter,
  hiddenCount,
  hasUnfilteredThreads,
  managerCount,
  allCount,
  hubLoaded,
  hubError,
  onRetryHub,
  onClearSelection,
  onFilter,
  find,
  onFind,
  onSelect,
  onPin,
  onNewProgram,
  onNewThread,
  onFocusComposer,
  entriesFor,
  headingEntriesFor,
  openMenu,
}: OverviewThreadRailProps) {
  const rows = sections.flatMap((section) => section.threads);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const empty = emptyStateFor(filter, find, hiddenCount, hasUnfilteredThreads, {
    showAll: () => onFilter("all"),
    clear: () => onFind(""),
    createProgram: onNewProgram,
    createThread: onNewThread,
  });
  const listbox = useRovingListbox({
    ids: rows.map((row) => row.id),
    selectedId,
    onSelect,
    onEnter: onFocusComposer,
    onEscape: () => find ? onFind("") : onClearSelection(),
  });

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1 outline-none"
    >
      <div className="space-y-2 border-b border-edge p-2">
        <div className="flex gap-1">
          <Input
            value={find}
            onChange={(event) => onFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (find) onFind("");
              else onClearSelection();
            }}
            placeholder="Find threads…"
            aria-label="Find threads"
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <DropdownMenu>
            <Tooltip content="New">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="New"><Plus className="h-3.5 w-3.5" /></Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onSelect={onNewThread}><MessageSquarePlus className="h-3.5 w-3.5" />New thread in project…</DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewProgram}><GitBranchPlus className="h-3.5 w-3.5" />New program</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              {value === "managers" ? `Managers ${managerCount}` : `All ${allCount}`}
            </button>
          ))}
        </div>
      </div>
      <div
        {...listbox}
        role="listbox"
        aria-label="Overview threads"
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {sections.map((section) => (
          <section
            key={section.kind === "coordinator" ? "coordinator" : section.key}
            role="group"
            aria-label={section.kind === "coordinator" ? "Coordinator" : section.name}
            className={cn(section.kind === "workspace" && section.offline && "opacity-60")}
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
              <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
              {section.serverLabel ? (
                <span>
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
              </span>
            </div>
            {section.kind === "coordinator" && section.serverLabel ? (
              <div className="px-2 pb-1 text-[10px] text-ink-faint">
                Programs on {section.serverLabel}
              </div>
            ) : null}
            {section.kind === "coordinator" && !hubLoaded ? (
              <div className="mx-2 mb-1 h-8 animate-pulse rounded bg-surface-2" />
            ) : null}
            {section.kind === "coordinator" && hubError ? (
              <div className="px-2 pb-2 text-[10px] text-danger">
                Programs unavailable: {hubError} ·{" "}
                <button type="button" className="underline" onClick={onRetryHub}>Retry</button>
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
                  subtitle: thread.program ? programSubtitle(thread.program) : undefined,
                  statusTitle: thread.indicator === "failed" && thread.summary
                    ? threadFailureTitle(thread.summary.node)
                    : undefined,
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
        {!rows.length && !hubError ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs font-medium text-ink">{empty.title}</p>
            <p className="mt-1 text-[11px] text-ink-muted">{empty.body}</p>
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" onClick={empty.action.run}>{empty.action.label}</Button>
              {empty.secondary ? <Button variant="ghost" size="sm" onClick={empty.secondary.run}>{empty.secondary.label}</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function programSubtitle(program: OverviewThread["program"]): string | undefined {
  if (!program) return undefined;
  const names = [...new Set(program.deliveries.map((delivery) => delivery.projectName))];
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const projects = shown.length ? ` · ${shown.join(", ")}` : "";
  return `${program.deliveries.length} deliveries${projects}`
    + (rest > 0 ? ` +${rest}` : "");
}
