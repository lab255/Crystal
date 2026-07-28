import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import type { FileEntry } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { CommandList, Dialog, DialogContent } from "@crystal/ui";

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

  useEffect(() => {
    if (!open) return;
    setQuery("");
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

  function pick(path: string): void {
    onPick(path);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Go to file" className="top-[30%] w-[560px]">
        {/* The shared filtered-list body — fuzzy ranking stays ours. */}
        <CommandList
          query={query}
          onQueryChange={setQuery}
          items={results}
          itemKey={(path) => path}
          loading={index === null}
          placeholder={index === null ? "Indexing workspace…" : "Type a file name…"}
          onPick={pick}
          renderItem={(path) => (
            <>
              <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="truncate">{path}</span>
            </>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
