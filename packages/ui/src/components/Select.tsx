import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "../cn.js";

/**
 * THE select. Every enum/entity chooser that reads best as a native dropdown
 * (status, priority, repo, epic, profile, template…) renders this instead of
 * re-inlining the field styling — before it existed the same class string was
 * copy-pasted in a dozen files, drifting one utility at a time. Native
 * `<select>` on purpose: free keyboard/a11y/mobile behavior, and options stay
 * plain data. Anything needing search or async options is a `Combobox`;
 * anything context-menu-shaped is a `DropdownMenu`.
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "children"> {
  /** Field height/type scale: md = form default (h-8), sm = inline rows (h-7), xs = dense chrome (h-6). */
  size?: "md" | "sm" | "xs";
  /** Options as data; or compose `<option>`/`<optgroup>` children yourself. */
  options?: readonly SelectOption[];
  children?: ReactNode;
}

const SIZE_CLASSES: Record<NonNullable<SelectProps["size"]>, string> = {
  md: "h-8 text-[13px]",
  sm: "h-7 text-xs",
  xs: "h-6 text-[11px]",
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", options, children, className, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-edge bg-surface-1 px-2 text-ink transition-colors",
        "focus:border-crystal-500/60 focus:outline-none",
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
});

/**
 * The labeled-field wrapper every editor/inspector re-implemented (a 10px
 * uppercase label above the control, optional hint below). One home, so the
 * label treatment can't drift per mode.
 */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  /** Muted helper line under the control. */
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {children}
      {hint ? <p className="mt-1 text-[10px] leading-snug text-ink-faint">{hint}</p> : null}
    </div>
  );
}
