import { cn } from "../cn.js";

export type StatusKind =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle";

const styles: Record<StatusKind, string> = {
  queued: "bg-ink-faint",
  running: "bg-info animate-pulse",
  completed: "bg-ok",
  failed: "bg-danger",
  cancelled: "bg-warn",
  idle: "bg-ink-faint",
};

export function StatusDot({ status, className }: { status: StatusKind; className?: string }) {
  return (
    <span
      aria-label={status}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", styles[status], className)}
    />
  );
}
