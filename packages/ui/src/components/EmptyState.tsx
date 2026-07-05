import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn.js";

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-2 p-8 text-center", className)}>
      {Icon ? (
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-edge bg-surface-2">
          <Icon className="h-5 w-5 text-ink-faint" />
        </div>
      ) : null}
      <div className="text-sm font-medium text-ink">{title}</div>
      {children ? <div className="max-w-72 text-xs leading-relaxed text-ink-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
