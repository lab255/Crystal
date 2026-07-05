import type { HTMLAttributes } from "react";
import { cn } from "../cn.js";

export type BadgeTone =
  | "neutral"
  | "violet"
  | "cyan"
  | "emerald"
  | "amber"
  | "rose"
  | "blue"
  | "slate";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-ink-muted border-edge-strong",
  violet: "bg-accent-violet/12 text-accent-violet border-accent-violet/25",
  cyan: "bg-accent-cyan/12 text-accent-cyan border-accent-cyan/25",
  emerald: "bg-accent-emerald/12 text-accent-emerald border-accent-emerald/25",
  amber: "bg-accent-amber/12 text-accent-amber border-accent-amber/25",
  rose: "bg-accent-rose/12 text-accent-rose border-accent-rose/25",
  blue: "bg-accent-blue/12 text-accent-blue border-accent-blue/25",
  slate: "bg-accent-slate/12 text-accent-slate border-accent-slate/25",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] font-medium leading-4",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
