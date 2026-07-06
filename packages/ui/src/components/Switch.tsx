import { cn } from "../cn.js";

/** Small on/off switch (hand-rolled — no Radix dependency needed). */
export function Switch({
  checked,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
        checked ? "border-crystal-400/60 bg-crystal-500/80" : "border-edge-strong bg-surface-1",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "mx-0.5 h-2.5 w-2.5 rounded-full transition-transform",
          checked ? "translate-x-3 bg-white" : "bg-ink-faint",
        )}
      />
    </button>
  );
}
