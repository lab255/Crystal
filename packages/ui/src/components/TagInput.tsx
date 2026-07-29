import { useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "../cn.js";
import { type BadgeTone } from "./Badge.js";

const PILL_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-ink-muted border-edge-strong",
  violet: "bg-accent-violet/12 text-accent-violet border-accent-violet/25",
  cyan: "bg-accent-cyan/12 text-accent-cyan border-accent-cyan/25",
  emerald: "bg-accent-emerald/12 text-accent-emerald border-accent-emerald/25",
  amber: "bg-accent-amber/12 text-accent-amber border-accent-amber/25",
  rose: "bg-accent-rose/12 text-accent-rose border-accent-rose/25",
  blue: "bg-accent-blue/12 text-accent-blue border-accent-blue/25",
  slate: "bg-accent-slate/12 text-accent-slate border-accent-slate/25",
};

export interface TagInputProps {
  /** The tags, owned by the caller — this component never keeps its own copy. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  "aria-label"?: string;
  /** Pill tone (matches Badge tones). */
  tone?: BadgeTone;
  className?: string;
  disabled?: boolean;
}

/**
 * Pilled tag entry — THE tag field. Values render as removable pills; the
 * trailing input adds on Enter, comma or blur (pasted "a, b, c" text splits),
 * Backspace on an empty input pops the last pill, duplicates are dropped.
 * Every tag-array field renders this instead of a free-text CSV input, so tag
 * editing can't drift per view.
 */
export function TagInput({
  value,
  onChange,
  placeholder = "add tag…",
  tone = "neutral",
  className,
  disabled,
  "aria-label": ariaLabel,
}: TagInputProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commitDraft = (text: string) => {
    const parts = text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setDraft("");
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    if (next.length !== value.length) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    // The frame is the click target: clicking anywhere inside focuses the
    // trailing input, so the whole control reads as one field.
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-edge bg-surface-1 px-1.5 py-1 transition-colors",
        "focus-within:border-crystal-500/60 focus-within:ring-2 focus-within:ring-crystal-500/20",
        disabled && "pointer-events-none opacity-60",
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-full border py-px pl-1.5 pr-0.5 text-[10.5px] font-medium leading-4",
            PILL_TONES[tone],
          )}
        >
          <span className="min-w-0 truncate">{tag}</span>
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((t) => t !== tag));
            }}
            aria-label={`Remove ${tag}`}
            className="rounded-full p-0.5 opacity-60 hover:bg-surface-0/40 hover:opacity-100"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commitDraft(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        aria-label={ariaLabel ?? "Add tag"}
        className="h-5 min-w-16 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}
