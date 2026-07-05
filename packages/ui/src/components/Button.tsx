import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "icon" | "icon-sm";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-crystal-500 text-white hover:bg-crystal-400 active:bg-crystal-600 shadow-sm shadow-crystal-500/20",
  secondary: "bg-surface-3 text-ink hover:bg-surface-active border border-edge-strong",
  ghost: "text-ink-muted hover:text-ink hover:bg-surface-3",
  outline: "border border-edge-strong text-ink hover:bg-surface-3",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs rounded-md gap-1",
  sm: "h-7 px-2.5 text-xs rounded-md gap-1.5",
  md: "h-8 px-3 text-[13px] rounded-lg gap-2",
  icon: "h-8 w-8 rounded-lg justify-center",
  "icon-sm": "h-6 w-6 rounded-md justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center font-medium transition-colors select-none",
        "focus-visible:outline-2 focus-visible:outline-crystal-400 focus-visible:outline-offset-1",
        "disabled:opacity-45 disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
