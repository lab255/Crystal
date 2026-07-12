import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn.js";
import { Input } from "./Input.js";

/**
 * Combobox — a text input with a filtered suggestion list. Point-in-time
 * suggestions (git refs, module paths…) rather than a strict select: typing a
 * value not in the list is allowed, Enter submits whatever is focused or
 * typed. Grouped options render under muted headings.
 */

export interface ComboboxOption {
  value: string;
  /** Display label; defaults to `value`. */
  label?: string;
  /** Muted right-aligned hint ("branch", "v2.1.0", a path…). */
  hint?: string;
  /** Group heading this option renders under. */
  group?: string;
  icon?: ReactNode;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Called when the user picks an option or presses Enter. */
  onSubmit?: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Max suggestions shown at once. */
  limit?: number;
}

export function Combobox({
  value,
  onChange,
  onSubmit,
  options,
  placeholder,
  className,
  inputClassName,
  disabled,
  autoFocus,
  limit = 12,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const matches = q
      ? options.filter(
          (o) =>
            o.value.toLowerCase().includes(q) || (o.label ?? "").toLowerCase().includes(q),
        )
      : options;
    // Prefix matches first, then the given order.
    const rank = (o: ComboboxOption): number => (o.value.toLowerCase().startsWith(q) ? 0 : 1);
    return (q ? [...matches].sort((a, b) => rank(a) - rank(b)) : matches).slice(0, limit);
  }, [options, value, limit]);

  useEffect(() => setActive(0), [value, open]);

  // Click-away dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (v: string): void => {
    onChange(v);
    setOpen(false);
    onSubmit?.(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = open ? filtered[active]?.value : undefined;
      pick(picked ?? value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Group in given order, ungrouped options first.
  const grouped = useMemo(() => {
    const groups = new Map<string, ComboboxOption[]>();
    for (const o of filtered) {
      const key = o.group ?? "";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
    }
    return [...groups.entries()];
  }, [filtered]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className={inputClassName}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && filtered.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-edge bg-surface-2 py-1 shadow-xl shadow-black/30">
          {grouped.map(([group, items]) => (
            <div key={group || "(none)"}>
              {group ? (
                <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {group}
                </div>
              ) : null}
              {items.map((o) => {
                const idx = filtered.indexOf(o);
                return (
                  <button
                    key={`${group}:${o.value}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault(); // beat the input blur
                      pick(o.value);
                    }}
                    onMouseEnter={() => setActive(idx)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px]",
                      idx === active ? "bg-surface-3 text-ink" : "text-ink-muted",
                    )}
                  >
                    {o.icon}
                    <span className="min-w-0 flex-1 truncate">{o.label ?? o.value}</span>
                    {o.hint ? <span className="shrink-0 text-[10px] text-ink-faint">{o.hint}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
