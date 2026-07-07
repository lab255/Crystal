import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "../cn.js";

/**
 * Right-click menu positioned at arbitrary canvas coordinates. Radix menus
 * anchor to a trigger element, so this small overlay handles the react-flow
 * (and tree-row) context-menu case: fixed positioning, viewport clamping,
 * click-away and Escape to dismiss. Supports nested submenus (hover or click
 * to open).
 */

export type MenuEntry =
  | {
      type: "item";
      label: string;
      icon?: LucideIcon;
      danger?: boolean;
      disabled?: boolean;
      /** Right-aligned hint, e.g. the linked module path. */
      hint?: string;
      checked?: boolean;
      onSelect: () => void;
    }
  | {
      type: "submenu";
      label: string;
      icon?: LucideIcon;
      disabled?: boolean;
      /** Right-aligned hint shown before the chevron. */
      hint?: string;
      entries: MenuEntry[];
    }
  | { type: "separator" }
  | { type: "heading"; label: string };

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (evt: PointerEvent) => {
      if (!ref.current?.contains(evt.target as Node)) onClose();
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Panels are fixed-positioned siblings inside this plain wrapper: submenus
  // must not be descendants of a blurred panel (backdrop-filter would turn
  // `fixed` into panel-relative positioning).
  return (
    <div ref={ref}>
      <MenuPanel x={x} y={y} entries={entries} onClose={onClose} align="point" />
    </div>
  );
}

/**
 * One menu panel plus (recursively) its open submenu. `align: "point"` clamps
 * around a cursor position; `"flyout"` opens beside an item rect, flipping to
 * the left edge when it would overflow.
 */
function MenuPanel({
  x,
  y,
  entries,
  onClose,
  align,
  anchor,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  align: "point" | "flyout";
  anchor?: DOMRect;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (align === "flyout" && anchor) {
      let fx = anchor.right - 2;
      if (fx + rect.width > window.innerWidth - 4) fx = Math.max(4, anchor.left - rect.width + 2);
      const fy = Math.max(4, Math.min(anchor.top - 5, window.innerHeight - rect.height - 4));
      setPos({ x: fx, y: fy });
    } else {
      setPos({
        x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
        y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
      });
    }
  }, [x, y, align, anchor]);

  const openEntry = open != null ? entries[open.index] : undefined;

  return (
    <>
      <div
        ref={panelRef}
        style={{ position: "fixed", left: pos.x, top: pos.y }}
        className="z-50 max-h-[70vh] min-w-44 overflow-y-auto rounded-xl border border-edge bg-surface-2/98 p-1 shadow-2xl shadow-black/50 backdrop-blur"
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {entries.map((entry, i) => {
          if (entry.type === "separator") {
            return <div key={i} className="mx-2 my-1 h-px bg-edge" />;
          }
          if (entry.type === "heading") {
            return (
              <div
                key={i}
                className="truncate px-2 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-ink-faint"
              >
                {entry.label}
              </div>
            );
          }
          if (entry.type === "submenu") {
            const Icon = entry.icon;
            const isOpen = open?.index === i;
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                disabled={entry.disabled}
                onPointerEnter={(e) => {
                  if (entry.disabled) return;
                  setOpen({ index: i, rect: e.currentTarget.getBoundingClientRect() });
                }}
                onClick={(e) => {
                  if (entry.disabled) return;
                  setOpen(isOpen ? null : { index: i, rect: e.currentTarget.getBoundingClientRect() });
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
                  entry.disabled
                    ? "cursor-default text-ink-faint"
                    : isOpen
                      ? "bg-surface-active text-ink"
                      : "text-ink-muted hover:bg-surface-active hover:text-ink",
                )}
              >
                {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint ? (
                  <span className="max-w-28 shrink-0 truncate font-mono text-[9.5px] text-ink-faint">
                    {entry.hint}
                  </span>
                ) : null}
                <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
              </button>
            );
          }
          const Icon = entry.icon;
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onPointerEnter={() => setOpen(null)}
              onClick={() => {
                if (entry.disabled) return;
                onClose();
                entry.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
                entry.disabled
                  ? "cursor-default text-ink-faint"
                  : entry.danger
                    ? "text-danger hover:bg-danger/10"
                    : "text-ink-muted hover:bg-surface-active hover:text-ink",
              )}
            >
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.checked ? <span className="shrink-0 text-crystal-300">✓</span> : null}
              {entry.hint ? (
                <span className="max-w-28 shrink-0 truncate font-mono text-[9.5px] text-ink-faint">
                  {entry.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {openEntry?.type === "submenu" && open ? (
        <MenuPanel
          x={open.rect.right}
          y={open.rect.top}
          entries={openEntry.entries}
          onClose={onClose}
          align="flyout"
          anchor={open.rect}
        />
      ) : null}
    </>
  );
}

/** Floating inline input for context-menu "Rename" (and other inline prompts). */
export function InlineRename({
  x,
  y,
  initial,
  placeholder,
  commitEmpty,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  initial: string;
  placeholder?: string;
  /** Commit even when the value equals `initial` (prompt-style usage). */
  commitEmpty?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const v = value.trim();
    if (v && (commitEmpty || v !== initial)) onCommit(v);
    else onCancel();
  };
  return (
    <div
      style={{ position: "fixed", left: Math.min(x, window.innerWidth - 240), top: y }}
      className="z-50 rounded-xl border border-edge bg-surface-2 p-1.5 shadow-2xl shadow-black/50"
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        className="w-52 rounded-lg border border-crystal-500/60 bg-surface-1 px-2 py-1 text-xs text-ink outline-none"
        aria-label={placeholder ?? "Rename"}
      />
    </div>
  );
}
