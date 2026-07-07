import { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileX2,
  PackagePlus,
  Share2,
  Unlink,
  Unplug,
  X,
} from "lucide-react";
import { tagValue, type HoistIntent, type ReviewFinding, type ReviewFindingKind } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";

const KIND_META: Record<ReviewFindingKind, { label: string; icon: typeof Copy }> = {
  duplicate: { label: "duplicates", icon: Copy },
  "dead-file": { label: "dead files", icon: FileX2 },
  "unused-export": { label: "unused exports", icon: Unplug },
  "boundary-leak": { label: "boundary leaks", icon: Unlink },
  "shared-util": { label: "shared utils", icon: Share2 },
};

/**
 * The review sweep: everything deterministic worth an engineer's attention
 * before (or instead of) reading the whole tree — dead files, unused exports
 * (barrel-aware), duplicate implementations, package-boundary leaks, and
 * utilities other modules keep reaching into. Rows jump straight to the
 * declaration in the editor; duplicate rows can record a hoist intent on the
 * active draft plan.
 */
export function ReviewPanel({
  ws,
  moduleFilter,
  onHoist,
  onOpenFile,
  onClose,
}: {
  ws?: string;
  /** Only findings whose primary file lives in this module (module level). */
  moduleFilter?: string;
  /** Record a hoist intent (parent appends to the draft, creating one if needed). */
  onHoist: (intent: HoistIntent) => void;
  /** Open a file in the editor at a specific line. */
  onOpenFile: (file: string, line: number) => void;
  onClose: () => void;
}) {
  const { client } = useCrystal();
  const [findings, setFindings] = useState<ReviewFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<ReviewFindingKind | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const fetchFindings = () => {
      client
        .request("review.findings", { ws })
        .then((res) => !cancelled && (setFindings(res.findings), setError(null)))
        .catch((err: Error) => !cancelled && setError(err.message));
    };
    fetchFindings();
    // The sweep follows both the code and landing intent tags.
    const refetch = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(fetchFindings, 500);
    };
    const disposeMap = client.events.on("codemap.changed", refetch);
    const disposeIndex = client.events.on("codeindex.changed", refetch);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      disposeMap();
      disposeIndex();
    };
  }, [client, ws]);

  const scoped = useMemo(() => {
    if (!findings) return null;
    if (!moduleFilter) return findings;
    return findings.filter(
      (f) => f.module === moduleFilter || f.related.some((r) => r.file.startsWith(`${moduleFilter}/`)),
    );
  }, [findings, moduleFilter]);

  const kindCounts = useMemo(() => {
    const counts = new Map<ReviewFindingKind, number>();
    for (const f of scoped ?? []) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    return counts;
  }, [scoped]);

  const intentTags = useMemo(() => {
    const tags = new Set<string>();
    for (const f of scoped ?? []) for (const t of f.tags) tags.add(t);
    return [...tags].sort();
  }, [scoped]);

  const shown = useMemo(() => {
    if (!scoped) return null;
    return scoped.filter(
      (f) => (!kindFilter || f.kind === kindFilter) && (!tagFilter || f.tags.includes(tagFilter)),
    );
  }, [scoped, kindFilter, tagFilter]);

  const warnCount = scoped?.filter((f) => f.severity === "warn").length ?? 0;

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          Review sweep
          {moduleFilter ? <span className="text-ink-faint"> in {moduleFilter}</span> : null}
        </span>
        {scoped ? (
          <span className="shrink-0 text-[10px] text-ink-faint">
            {warnCount} warning{warnCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close review sweep">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* kind + intent filters */}
      <div className="flex flex-wrap items-center gap-1 border-b border-edge px-3 py-1.5">
        {(Object.keys(KIND_META) as ReviewFindingKind[])
          .filter((k) => (kindCounts.get(k) ?? 0) > 0)
          .map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kindFilter === k}
              onClick={() => setKindFilter(kindFilter === k ? null : k)}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                kindFilter === k ? "bg-crystal-500/15 text-ink" : "text-ink-faint hover:text-ink-muted",
              )}
            >
              {KIND_META[k].label} {kindCounts.get(k)}
            </button>
          ))}
        {intentTags.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-pressed={tagFilter === tag}
            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
            className={cn(
              "rounded-md px-1.5 py-0.5 font-mono text-[9.5px] transition-colors",
              tagFilter === tag ? "bg-warn/15 text-warn" : "text-ink-faint hover:text-ink-muted",
            )}
          >
            {tagValue(tag)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <div className="text-[11px] text-warn">{error}</div> : null}
        {!shown && !error ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> sweeping…
          </div>
        ) : null}
        {shown?.map((finding) => {
          const Icon = KIND_META[finding.kind].icon;
          return (
            <div
              key={finding.id}
              className="mb-2 rounded-lg border border-edge bg-surface-2 p-2"
            >
              <button
                type="button"
                className="flex w-full items-start gap-1.5 text-left"
                onClick={() => onOpenFile(finding.ref.file, finding.ref.line)}
                title={finding.detail}
              >
                <Icon
                  className={cn(
                    "mt-0.5 h-3 w-3 shrink-0",
                    finding.severity === "warn" ? "text-warn" : "text-ink-faint",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] text-ink">{finding.title}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-muted">
                    {finding.ref.file}
                    <span className="text-ink-faint">:{finding.ref.line}</span>
                  </span>
                </span>
                {finding.severity === "info" ? <Badge tone="neutral">info</Badge> : null}
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
              </button>
              {finding.related.length > 0 ? (
                <div className="mt-1 space-y-0.5 pl-4">
                  {finding.related.map((ref) => (
                    <button
                      key={`${ref.file}#${ref.symbol ?? ""}:${ref.line}`}
                      type="button"
                      className="block w-full truncate text-left font-mono text-[10px] text-ink-muted hover:text-ink"
                      onClick={() => onOpenFile(ref.file, ref.line)}
                    >
                      {ref.file}
                      <span className="text-ink-faint">:{ref.line}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {finding.refactor ? (
                <div className="mt-1.5 pl-4">
                  <Tooltip content={`Record a hoist into ${finding.refactor.targetModule} on the draft plan`}>
                    <Button variant="secondary" size="xs" onClick={() => onHoist(finding.refactor!)}>
                      <PackagePlus className="h-3 w-3" /> Hoist to {finding.refactor.targetModule}
                    </Button>
                  </Tooltip>
                </div>
              ) : null}
            </div>
          );
        })}
        {shown && shown.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="Nothing to flag">
            No dead files, unused exports, duplicates or boundary leaks
            {moduleFilter ? " in this module" : ""} — or the filters hide them.
          </EmptyState>
        ) : null}
      </div>
    </aside>
  );
}
