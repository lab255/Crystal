import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "../cn.js";

/**
 * THE filtered-list picker body: a search input plus a keyboard-navigable
 * result list. The command palette, the editor's quick-open and any
 * symbol/test pickers compose this instead of each re-implementing the same
 * ArrowUp/ArrowDown/Enter handler, highlight index, and active-row styling
 * (they had all drifted — none of them scrolled the active row into view).
 *
 * Deliberately presentational: the caller owns the query state and the
 * filtering (substring, fuzzy, async — whatever fits its data); this renders
 * the results and turns keys/clicks into `onPick`. Host it inside a Dialog
 * (palette-style) or a popover (inline pickers).
 */
export function CommandList<T>({
  query,
  onQueryChange,
  items,
  itemKey,
  renderItem,
  onPick,
  placeholder = "Type to search…",
  emptyText = "No matches",
  /** True while the item source is still loading (shows placeholder, no empty state). */
  loading = false,
  autoFocus = true,
  listClassName,
  inputAriaLabel,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  /** Already filtered + capped by the caller. */
  items: readonly T[];
  itemKey: (item: T) => string;
  /** Row content (icon + text + hints). The row button and active styling are provided. */
  renderItem: (item: T, active: boolean) => ReactNode;
  onPick: (item: T) => void;
  placeholder?: string;
  emptyText?: string;
  loading?: boolean;
  autoFocus?: boolean;
  /** Extra classes on the scrollable list (e.g. max-height overrides). */
  listClassName?: string;
  inputAriaLabel?: string;
}) {
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** True when the last highlight move came from the keyboard (see below). */
  const viaKey = useRef(false);

  // New query or result set (by identity — a same-length swap must not leave
  // the highlight silently pointing at a different row): restart at the top…
  useEffect(() => setHighlight(0), [query, items]);
  // …and keep the active row visible while arrowing through a long list.
  // Keyboard moves only: hovering must never scroll the list under a
  // stationary cursor (which re-fires mouseenter on the next row and jitters).
  useEffect(() => {
    if (!viaKey.current) return;
    viaKey.current = false;
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const active = Math.min(highlight, Math.max(items.length - 1, 0));

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-edge px-1 pb-2.5">
        <Search className="h-4 w-4 text-ink-faint" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              viaKey.current = true;
              setHighlight((h) => Math.min(h + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              viaKey.current = true;
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              // Always swallowed — inside a <form> host, Enter on an empty
              // list must not submit the form as a side effect.
              e.preventDefault();
              if (items[active]) onPick(items[active]);
            }
          }}
          placeholder={placeholder}
          aria-label={inputAriaLabel ?? placeholder}
          className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      <div ref={listRef} className={cn("max-h-80 overflow-y-auto p-1.5", listClassName)}>
        {items.map((item, i) => (
          <button
            key={itemKey(item)}
            type="button"
            data-active={i === active || undefined}
            onClick={() => onPick(item)}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
              i === active ? "bg-crystal-500/20 text-ink" : "text-ink-muted",
            )}
          >
            {renderItem(item, i === active)}
          </button>
        ))}
        {!loading && items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-ink-faint">{emptyText}</div>
        ) : null}
      </div>
    </div>
  );
}
