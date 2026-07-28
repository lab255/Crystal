import { ArrowRight, GitCompareArrows, X } from "lucide-react";
import type { SystemOverviewDiff } from "@crystal/core";
import { Button, EmptyState, Tooltip, cn } from "@crystal/ui";

/**
 * The vs-ref review's entry list on the architecture view: every structural
 * change enumerated and clickable, so the review is walkable instead of a
 * hunt for tinted nodes (ported from the surfaces map's diff panel). Rows
 * speak RAW overview ids — the caller maps to canonical canvas ids.
 */
export function DiffPanel({
  vsRef,
  diff,
  onFocusSystem,
  onSelectEdge,
  onClose,
}: {
  /** The ref being reviewed against, for the header. */
  vsRef: string;
  diff: SystemOverviewDiff;
  onFocusSystem: (rawId: string) => void;
  /** Open a surviving boundary in the contracts inspector ("source->target"). */
  onSelectEdge: (key: string) => void;
  onClose: () => void;
}) {
  const section = (title: string, tone: "ok" | "danger" | "warn", count: number) =>
    count > 0 ? (
      <div className="flex items-center justify-between px-1.5 pb-1 pt-3 first:pt-1">
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            tone === "ok" ? "text-ok" : tone === "danger" ? "text-danger" : "text-warn",
          )}
        >
          {title}
        </span>
        <span className="text-[10px] text-ink-faint">{count}</span>
      </div>
    ) : null;

  const row = (
    key: string,
    label: React.ReactNode,
    onClick: () => void,
    detail?: string,
  ) => {
    const button = (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {detail ? <span className="shrink-0 text-[10px] text-ink-faint">{detail}</span> : null}
      </button>
    );
    return detail ? (
      <Tooltip key={key} content={detail}>
        {button}
      </Tooltip>
    ) : (
      <span key={key} className="contents">
        {button}
      </span>
    );
  };

  const arrow = <ArrowRight className="mx-1 inline h-3 w-3 text-ink-faint" />;
  const empty = diff.total === 0 && diff.resized.length === 0 && diff.reweighted.length === 0;

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          <GitCompareArrows className="h-3.5 w-3.5 text-crystal-300" />
          vs <span className="font-mono normal-case">{vsRef}</span>
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close diff list">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {empty ? (
          <EmptyState title="No structural drift">
            The architecture at {vsRef} matches the working tree — same systems, same
            boundaries, same external services.
          </EmptyState>
        ) : (
          <>
            {section("New systems", "ok", diff.addedSystems.length)}
            {diff.addedSystems.map((s) =>
              row(`as:${s.id}`, s.name, () => onFocusSystem(s.id), `${s.fileCount}f`),
            )}
            {section("Removed systems", "danger", diff.removedSystems.length)}
            {diff.removedSystems.map((s) =>
              row(`rs:${s.id}`, s.name, () => onFocusSystem(s.id), `${s.fileCount}f`),
            )}
            {section("Resized", "warn", diff.resized.length)}
            {diff.resized.map((r) =>
              row(`rz:${r.id}`, r.name, () => onFocusSystem(r.id), `${r.before} → ${r.after}f`),
            )}
            {section("New links", "ok", diff.addedLinks.length)}
            {diff.addedLinks.map((l) =>
              row(
                `al:${l.source}->${l.target}`,
                <>
                  {l.sourceName}
                  {arrow}
                  {l.targetName}
                </>,
                () => onSelectEdge(`${l.source}->${l.target}`),
                l.symbols.slice(0, 3).join(", ") || undefined,
              ),
            )}
            {section("Removed links", "danger", diff.removedLinks.length)}
            {diff.removedLinks.map((l) =>
              row(
                `rl:${l.source}->${l.target}`,
                <>
                  {l.sourceName}
                  {arrow}
                  {l.targetName}
                </>,
                () => onFocusSystem(l.source),
                l.symbols.slice(0, 3).join(", ") || undefined,
              ),
            )}
            {section("Reweighted links", "warn", diff.reweighted.length)}
            {diff.reweighted.map((l) =>
              row(
                `wl:${l.source}->${l.target}`,
                <>
                  {l.sourceName}
                  {arrow}
                  {l.targetName}
                </>,
                () => onSelectEdge(`${l.source}->${l.target}`),
                `${l.before} → ${l.after}`,
              ),
            )}
            {section("New externals", "ok", diff.addedExternals.length)}
            {diff.addedExternals.map((e, i) =>
              row(`ae:${i}`, `${e.systemName} + ${e.name}`, () => onFocusSystem(e.system)),
            )}
            {section("Removed externals", "danger", diff.removedExternals.length)}
            {diff.removedExternals.map((e, i) =>
              row(`re:${i}`, `${e.systemName} − ${e.name}`, () => onFocusSystem(e.system)),
            )}
          </>
        )}
      </div>
    </div>
  );
}
