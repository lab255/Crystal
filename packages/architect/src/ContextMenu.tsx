import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@crystal/ui";

/**
 * Right-click menu positioned at arbitrary canvas coordinates. Radix menus
 * anchor to a trigger element, so this small overlay handles the react-flow
 * context-menu case: fixed positioning, viewport clamping, click-away and
 * Escape to dismiss.
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
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

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

  return (
    <div
      ref={ref}
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
        const Icon = entry.icon;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
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
  );
}

/** Floating inline input for context-menu "Rename". */
export function InlineRename({
  x,
  y,
  initial,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const v = value.trim();
    if (v && v !== initial) onCommit(v);
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
        className="w-52 rounded-lg border border-crystal-500/60 bg-surface-1 px-2 py-1 text-xs text-ink outline-none"
        aria-label="Rename"
      />
    </div>
  );
}
