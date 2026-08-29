import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Pin, Unplug } from "lucide-react";
import { Button, Input, StatusDot, Tooltip, cn, type MenuEntry } from "@crystal/ui";
import { ThreadRow } from "../ThreadRow.js";
import type { OverviewSection, OverviewThread } from "./overview-thread-model.js";

export function OverviewThreadRail({ sections, selectedId, filter, onFilter, find, onFind, onSelect, onPin, onNewProgram, entriesFor, headingEntriesFor, openMenu }: {
  sections: OverviewSection[]; selectedId: string | null; filter: "managers" | "all";
  onFilter: (value: "managers" | "all") => void; find: string; onFind: (value: string) => void;
  onSelect: (id: string) => void; onPin: (key: string) => void; onNewProgram: () => void;
  entriesFor: (thread: OverviewThread) => MenuEntry[];
  headingEntriesFor: (section: OverviewSection) => MenuEntry[];
  openMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void;
}) {
  const rows = sections.flatMap((section) => section.threads);
  const rail = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  return <aside ref={rail} role="listbox" aria-label="Overview threads" tabIndex={0}
    onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      event.preventDefault();
      const index = rows.findIndex((row) => row.id === selectedId);
      if (event.key === "Enter") { if (index >= 0) onSelect(rows[index]!.id); return; }
      const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
      if (rows[next]) onSelect(rows[next]!.id);
    }}
    className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1 outline-none">
    <div className="space-y-2 border-b border-edge p-2">
      <div className="flex gap-1">
        <Input value={find} onChange={(e) => onFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onFind(""); }} placeholder="Find threads…" aria-label="Find threads" className="h-7 min-w-0 flex-1 text-xs" />
        <Tooltip content="New program"><Button variant="ghost" size="icon-sm" aria-label="New program" onClick={onNewProgram}><MessageSquarePlus className="h-3.5 w-3.5" /></Button></Tooltip>
      </div>
      <div className="grid grid-cols-2 rounded-md bg-surface-2 p-0.5">
        {(["managers", "all"] as const).map((value) => <button key={value} type="button" onClick={() => onFilter(value)} className={cn("rounded px-2 py-1 text-[11px] capitalize", filter === value ? "bg-surface-3 font-medium text-ink" : "text-ink-muted")}>{value}</button>)}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {sections.map((section) => <section key={section.kind === "coordinator" ? "coordinator" : section.key}>
        <button type="button" onContextMenu={(e) => openMenu(e, headingEntriesFor(section))}
          className={cn("sticky top-0 z-10 flex w-full items-center gap-1 bg-surface-1 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-faint", section.kind === "workspace" && section.offline && "opacity-60")}
          >
          {section.kind === "workspace" && section.offline ? <Unplug className="h-3 w-3" /> : null}
          {section.kind === "coordinator" ? "Coordinator" : section.name}
          {section.serverLabel ? <span className="ml-auto normal-case tracking-normal">{section.serverLabel}</span> : null}
        </button>
        <div className="space-y-0.5">
          {section.threads.map((thread) => thread.summary ? <ThreadRow key={thread.id} thread={thread.summary} selected={selectedId === thread.id} nowMs={nowMs} onSelect={() => onSelect(thread.id)} onTogglePin={() => onPin(thread.readKey)} onContextMenu={(e) => openMenu(e, entriesFor(thread))} /> :
            <div key={thread.id} className={cn("group relative rounded-lg", selectedId === thread.id ? "bg-surface-3" : "hover:bg-surface-2")}>
              <button type="button" role="option" aria-selected={selectedId === thread.id} onClick={() => onSelect(thread.id)} onContextMenu={(e) => openMenu(e, entriesFor(thread))} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left">
                <StatusDot status={thread.indicator === "needs-input" ? "needs-you" : thread.indicator === "running" ? "running" : thread.indicator === "failed" ? "failed" : thread.indicator === "unread" ? "queued" : "idle"} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{thread.title}</span>{thread.pinned ? <Pin className="h-3 w-3 text-ink-faint" /> : null}
              </button>
            </div>)}
        </div>
      </section>)}
      {!rows.length ? <div className="px-3 py-8 text-center"><p className="text-xs font-medium text-ink">No manager threads yet</p><p className="mt-1 text-[11px] text-ink-muted">Starting a workflow in a project creates one.</p><Button className="mt-3" size="sm" onClick={onNewProgram}>New program</Button></div> : null}
    </div>
  </aside>;
}
