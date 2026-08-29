import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Spinner } from "@crystal/ui";

function LoadAllButton({ loading, onLoadAll }: { loading: boolean; onLoadAll: () => void | Promise<void> }) {
  return (
    <button
      type="button"
      onClick={() => void onLoadAll()}
      disabled={loading}
      className="flex items-center gap-1 text-[10px] font-medium text-accent-amber hover:underline disabled:opacity-50"
    >
      {loading ? <Spinner className="h-3 w-3" /> : null}
      {loading ? "Loading…" : "Load all"}
    </button>
  );
}

export function TranscriptFindBar({
  query,
  onQueryChange,
  activeIndex,
  hitCount,
  unloadedCount,
  onPrevious,
  onNext,
  onClose,
  onLoadAll,
  loadingAll = false,
  inputRef,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  activeIndex: number;
  hitCount: number;
  unloadedCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onLoadAll?: () => void | Promise<void>;
  loadingAll?: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="flex shrink-0 items-center gap-1.5 border-b border-edge bg-surface-1 px-3 py-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.shiftKey ? onPrevious() : onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in thread…"
        aria-label="Find in thread"
        className="min-w-0 flex-1 rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-ink outline-none focus:border-accent-amber"
      />
      <div className="flex items-center gap-3">
        <span role="status" aria-live="polite" className="min-w-12 text-center text-[10px] text-ink-muted">
          {!query.trim() ? null : hitCount ? `${activeIndex + 1} of ${hitCount}` : "No results"}
        </span>
        {unloadedCount ? <span className="text-[10px] text-ink-faint">{unloadedCount} older turns not loaded</span> : null}
      </div>
      <button type="button" aria-label="Previous match" onClick={onPrevious} disabled={!hitCount} className="rounded p-1 text-ink-muted hover:bg-surface-2 disabled:opacity-40"><ChevronUp className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Next match" onClick={onNext} disabled={!hitCount} className="rounded p-1 text-ink-muted hover:bg-surface-2 disabled:opacity-40"><ChevronDown className="h-3.5 w-3.5" /></button>
      {unloadedCount && onLoadAll ? <LoadAllButton loading={loadingAll} onLoadAll={onLoadAll} /> : null}
      <button type="button" aria-label="Close find" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-2"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
