import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button, Input, cn } from "@crystal/ui";
import { ThreadRow } from "./ThreadRow.js";
import type { ThreadGroup } from "./thread-model.js";

/**
 * The thread rail: every conversation in this workspace, grouped by board,
 * one precedence-resolved status dot per row. Needs-input floats to the top
 * of its group — the rail IS the workspace's inbox.
 */
export function ThreadRail({
  groups,
  selectedThreadId,
  find,
  onFind,
  onSelect,
  onTogglePin,
  onCompose,
  composing,
  className,
}: {
  groups: readonly ThreadGroup[];
  selectedThreadId: string | null;
  find: string;
  onFind: (value: string) => void;
  onSelect: (threadId: string) => void;
  onTogglePin: (threadId: string) => void;
  onCompose: () => void;
  composing: boolean;
  className?: string;
}) {
  // One clock for every row's recency label; a minute tick is plenty.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const empty = groups.length === 0;
  return (
    <aside className={cn("flex h-full min-h-0 w-72 shrink-0 flex-col border-r border-edge", className)}>
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint" />
          <Input
            value={find}
            onChange={(e) => onFind(e.target.value)}
            placeholder="Filter threads…"
            aria-label="Filter threads"
            className="h-7 pl-6 text-xs"
          />
        </div>
        <Button
          variant={composing ? "primary" : "ghost"}
          size="icon-sm"
          aria-label="New thread"
          onClick={onCompose}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {empty ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-ink-faint">
            No threads yet. Start one with the + button — each conversation with an agent lives
            here, workers nested inside it.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.projectId ?? "~adhoc"} className="mb-2">
              <h3 className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                {group.name}
              </h3>
              <div className="space-y-0.5">
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedThreadId}
                    nowMs={nowMs}
                    onSelect={() => onSelect(thread.id)}
                    onTogglePin={() => onTogglePin(thread.id)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
