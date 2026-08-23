import { useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import {
  suggestIndexFacets,
  type CodeIndex,
  type IndexFacetSuggestion,
} from "@crystal/core";
import { useCrystal, useLens, useNavUpdate } from "@crystal/client";
import { Badge, Button, Spinner, Tooltip, cn } from "@crystal/ui";

/**
 * Facet lenses over the code map. Suggestions come straight from the code
 * index (heuristic name/path tags merged with agent enrichments); picking one
 * filters the map down to the members that carry the facet's intent. The
 * "index with an agent" action lives in the Jobs mode now — this footer links
 * there, where indexing runs scoped to your diff by default.
 */
export function FacetsPanel({
  index,
  staleFiles,
  activeTags,
  onSelect,
  onClear,
  onClose,
  ws,
}: {
  /** Loaded code index (null while fetching). */
  index: CodeIndex | null;
  /** Files without fresh agent enrichment — the next indexing batch. */
  staleFiles: string[];
  /** Tags of the active lens ([] when none). */
  activeTags: string[];
  /** Activate a lens (facet name is derived from its tags). */
  onSelect: (suggestion: IndexFacetSuggestion) => void;
  onClear: () => void;
  onClose: () => void;
  ws: string;
}) {
  const updateNav = useNavUpdate();
  const { lensStore } = useCrystal();
  const [indexError, setIndexError] = useState<string | null>(null);
  const indexing = useLens((s) => s.indexingByWs[ws] === true);

  const suggestions = useMemo(() => (index ? suggestIndexFacets(index) : []), [index]);
  const activeKey = activeTags.join(",");

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">Facets</span>
        {activeTags.length > 0 ? (
          <Button variant="ghost" size="xs" onClick={onClear}>
            clear lens
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close facets">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!index ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> reading the code index…
          </div>
        ) : suggestions.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No facets detected yet — the heuristic index found no recurring intents. Try indexing
            with an agent below; it reads the files and tags what the code is actually for.
          </div>
        ) : (
          <div className="space-y-1.5">
            {suggestions.map((s) => {
              const active = s.tags.join(",") === activeKey;
              return (
                <button
                  key={s.tags.join(",")}
                  type="button"
                  onClick={() => (active ? onClear() : onSelect(s))}
                  aria-pressed={active}
                  className={cn(
                    "block w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    active
                      ? "border-crystal-400 bg-crystal-500/10"
                      : "border-edge bg-surface-2 hover:border-edge-strong",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[11.5px] font-semibold",
                        active ? "text-crystal-300" : "text-ink",
                      )}
                    >
                      {s.name}
                    </span>
                    <Badge tone={active ? "cyan" : "neutral"}>{s.members} members</Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-ink-faint">
                    <span>
                      {s.files} file{s.files !== 1 ? "s" : ""} · {s.modules} module
                      {s.modules !== 1 ? "s" : ""}
                    </span>
                    <Tooltip content={s.sampleFiles.join("\n")}>
                      <span className="truncate font-mono">{s.sampleFiles[0]}</span>
                    </Tooltip>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-edge px-3 py-2.5">
        <div className={cn("mb-1.5 text-[10px]", indexError ? "text-danger" : "text-ink-faint")}>
          {indexError ?? (indexing
            ? "Indexing intents…"
            : staleFiles.length > 0
            ? `${staleFiles.length} file${staleFiles.length !== 1 ? "s" : ""} not yet agent-indexed — symbolic tags (names, paths, call graph) only.`
            : "Every file carries a fresh agent enrichment.")}
        </div>
        {staleFiles.length > 0 && !indexing ? (
          <Button variant="secondary" size="xs" onClick={() => {
            setIndexError(null);
            void lensStore.getState().requestIntentIndex(ws, { full: true }).catch((error: Error) => {
              setIndexError(error.message);
            });
          }}>
            <Sparkles className="h-3 w-3" />
            Index intents
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" onClick={() => updateNav({ mode: "jobs" })}>
          {indexing ? "run in Jobs" : "Jobs"}
        </Button>
      </div>
    </aside>
  );
}
