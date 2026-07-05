import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import type { FileEntry } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Dialog, DialogContent, cn } from "@crystal/ui";

const MAX_FILES = 4000;
const MAX_RESULTS = 40;

/** Simple subsequence fuzzy match; lower score is better, null = no match. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  let lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    score += idx - (lastHit + 1); // penalize gaps
    lastHit = idx;
    ti = idx + 1;
  }
  score += (t.length - q.length) * 0.01; // slight preference for shorter paths
  if (t.endsWith("/" + q) || t === q) score -= 100;
  return score;
}

async function walkFiles(
  list: (path: string) => Promise<FileEntry[]>,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = ["."];
  while (queue.length && files.length < MAX_FILES) {
    const batch = queue.splice(0, 8);
    const results = await Promise.all(
      batch.map((dir) => list(dir).catch(() => [] as FileEntry[])),
    );
    for (const entries of results) {
      for (const entry of entries) {
        if (entry.kind === "dir") queue.push(entry.path);
        else files.push(entry.path);
      }
    }
  }
  return files;
}

export function QuickOpen({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const { client } = useCrystal();
  const [index, setIndex] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    if (index === null) {
      void walkFiles((path) =>
        client.request("fs.list", { path }).then((r) => r.entries),
      ).then(setIndex);
    }
  }, [open]);

  const results = useMemo(() => {
    if (!index) return [];
    if (!query.trim()) return index.slice(0, MAX_RESULTS);
    return index
      .map((path) => ({ path, score: fuzzyScore(query.trim(), path) }))
      .filter((r): r is { path: string; score: number } => r.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.path);
  }, [index, query]);

  useEffect(() => setHighlight(0), [query]);

  function pick(path: string): void {
    onPick(path);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Go to file" className="top-[30%] w-[560px]">
        <div>
          <div className="flex items-center gap-2 border-b border-edge px-1 pb-2.5">
            <Search className="h-4 w-4 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter" && results[highlight]) {
                  pick(results[highlight]);
                }
              }}
              placeholder={index === null ? "Indexing workspace…" : "Type a file name…"}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
            {results.map((path, i) => (
              <button
                key={path}
                type="button"
                onClick={() => pick(path)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  i === highlight ? "bg-crystal-500/20 text-ink" : "text-ink-muted",
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="truncate">{path}</span>
              </button>
            ))}
            {index !== null && results.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-faint">No matches</div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
