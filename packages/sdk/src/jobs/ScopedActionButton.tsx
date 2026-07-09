import { ChevronDown } from "lucide-react";
import type { ChangeScope } from "@crystal/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "@crystal/ui";

/** A job's run scope: a diff ("worktree"/"base") or the whole repo ("full"). */
export type JobScope = ChangeScope | "full";

export const JOB_SCOPES: JobScope[] = ["worktree", "base", "full"];

export const SCOPE_LABELS: Record<JobScope, string> = {
  worktree: "Working tree",
  base: "Vs main",
  full: "Full scan",
};

/**
 * Split button for a scope-aware agent job: the primary click dispatches at the
 * current scope (diff by default); the caret opens the other scopes, each with
 * its live file count. Selecting a scope both remembers it and runs it — the
 * parent's `onRun` handler updates the remembered scope.
 */
export function ScopedActionButton({
  label,
  icon,
  scope,
  counts,
  busy,
  onRun,
}: {
  label: string;
  icon?: React.ReactNode;
  scope: JobScope;
  /** File count per scope for the menu ("full" = whole index). */
  counts?: Partial<Record<JobScope, number>>;
  busy?: boolean;
  onRun: (scope: JobScope) => void;
}) {
  return (
    <div className="flex items-stretch">
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={() => onRun(scope)}
        className="gap-1.5 rounded-r-none"
      >
        {busy ? <Spinner className="h-3.5 w-3.5" /> : icon}
        {label}
        <span className="text-[10px] font-normal opacity-70">· {SCOPE_LABELS[scope]}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            aria-label="Choose scope"
            className="rounded-l-none border-l border-black/20 px-1.5"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" className="min-w-52">
          {JOB_SCOPES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => onRun(s)} className="gap-2">
              <span className="flex-1">{SCOPE_LABELS[s]}</span>
              {counts?.[s] != null ? (
                <span className="text-[10px] text-ink-faint">
                  {counts[s]} {s === "full" ? "files" : "changed"}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
