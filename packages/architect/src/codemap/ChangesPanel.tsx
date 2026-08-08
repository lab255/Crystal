import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FilePlus2, FilePen, FlaskConical, History, Unplug, X } from "lucide-react";
import type { ChangedFileEntry, WorkingSetReport } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";

const WINDOW_OPTIONS: { label: string; hours: number }[] = [
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
];

/**
 * The recent working set — "what moved lately?", from file timestamps rather
 * than a VCS, so it answers even in workspaces without git (where agents and
 * humans still edit continuously). Each file row carries its wiring: importer
 * count, dependents outside the changed set (blast radius), and an "unwired"
 * badge on additions nothing imports yet.
 */
export function ChangesPanel({
  ws,
  moduleFilter,
  reviewActive = false,
  onOpenFile,
  onClose,
}: {
  ws?: string;
  /** Only files owned by this module (module level). */
  moduleFilter?: string;
  /** A vs-ref review is active; distinguish this mtime list from its diff. */
  reviewActive?: boolean;
  onOpenFile: (file: string, line: number) => void;
  onClose: () => void;
}) {
  const { client } = useCrystal();
  const [report, setReport] = useState<WorkingSetReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const fetchChanges = () => {
      client
        .request("codemap.changes", { ws, sinceHours: hours })
        .then((res) => !cancelled && (setReport(res), setError(null)))
        .catch((err: Error) => !cancelled && setError(err.message));
    };
    fetchChanges();
    const refetch = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(fetchChanges, 500);
    };
    const dispose = client.events.on("codemap.changed", refetch);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      dispose();
    };
  }, [client, ws, hours]);

  const files = useMemo(() => {
    if (!report) return null;
    if (!moduleFilter) return report.files;
    return report.files.filter((f) => f.module === moduleFilter);
  }, [report, moduleFilter]);

  const unwired = useMemo(() => new Set(report?.unwired ?? []), [report]);
  const addedCount = files?.filter((f) => f.status === "added").length ?? 0;

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <History className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          Recent edits (file timestamps)
          {moduleFilter ? <span className="text-ink-faint"> in {moduleFilter}</span> : null}
        </span>
        {files ? (
          <span className="shrink-0 text-[10px] text-ink-faint">
            {files.length} file{files.length === 1 ? "" : "s"}
            {addedCount > 0 ? `, ${addedCount} new` : ""}
          </span>
        ) : null}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close recent edits">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* window picker + module rollup */}
      <div className="flex flex-wrap items-center gap-1 border-b border-edge px-3 py-1.5">
        {WINDOW_OPTIONS.map((w) => (
          <button
            key={w.hours}
            type="button"
            aria-pressed={hours === w.hours}
            onClick={() => setHours(w.hours)}
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
              hours === w.hours ? "bg-crystal-500/15 text-ink" : "text-ink-faint hover:text-ink-muted",
            )}
          >
            {w.label}
          </button>
        ))}
        {!moduleFilter && report && report.modules.length > 0 ? (
          <span className="ml-1 flex min-w-0 flex-wrap items-center gap-1">
            {report.modules.slice(0, 6).map((m) => (
              <Tooltip
                key={m.module}
                content={`${m.added} added, ${m.modified} modified${m.testsTouched ? ", tests touched" : ", no tests touched"}`}
              >
                <span className="flex items-center gap-0.5 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-muted">
                  {m.module}
                  <span className="text-ink-faint">{m.added + m.modified}</span>
                  {m.testsTouched ? <FlaskConical className="h-2.5 w-2.5 text-ok" /> : null}
                </span>
              </Tooltip>
            ))}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {reviewActive ? (
          <div className="mb-3 rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-muted">
            This is the mtime working set — the review&apos;s changed files are on the diff badge/panel.
          </div>
        ) : null}
        {error ? <div className="text-[11px] text-warn">{error}</div> : null}
        {!files && !error ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> scanning…
          </div>
        ) : null}
        {files?.map((f) => (
          <ChangedFileRow key={f.path} file={f} unwired={unwired.has(f.path)} onOpenFile={onOpenFile} />
        ))}
        {files && files.length === 0 ? (
          <EmptyState icon={History} title="Nothing moved">
            No code files were touched in the last {hours >= 24 ? `${hours / 24} day${hours > 24 ? "s" : ""}` : `${hours} hours`}
            {moduleFilter ? " in this module" : ""}.
          </EmptyState>
        ) : null}
        {report && !moduleFilter && report.total > report.files.length ? (
          <div className="mt-1 text-[10px] text-ink-faint">
            Showing {report.files.length} of {report.total} touched files.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ChangedFileRow({
  file,
  unwired,
  onOpenFile,
}: {
  file: ChangedFileEntry;
  unwired: boolean;
  onOpenFile: (file: string, line: number) => void;
}) {
  const added = file.status === "added";
  const Icon = added ? FilePlus2 : FilePen;
  const exportsLine = file.exports.map((e) => e.name).join(", ");
  return (
    <div className="mb-2 rounded-lg border border-edge bg-surface-2 p-2">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 text-left"
        onClick={() => onOpenFile(file.path, 1)}
        title={`${added ? "Added" : "Modified"} ${new Date(file.mtime).toLocaleString()} — ${file.loc} loc, ${file.importedBy} importer${file.importedBy === 1 ? "" : "s"}`}
      >
        <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", added ? "text-ok" : "text-crystal-300")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-ink">{file.path}</span>
          {exportsLine ? (
            <span className="block truncate text-[10px] text-ink-muted">{exportsLine}</span>
          ) : null}
        </span>
        {file.test ? <Badge tone="neutral">test</Badge> : null}
        {unwired ? (
          <Tooltip content="New file no other file imports yet (and no entry convention claims)">
            <span className="flex items-center gap-0.5 text-[10px] text-warn">
              <Unplug className="h-3 w-3" /> unwired
            </span>
          </Tooltip>
        ) : null}
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
      </button>
      {file.dependents.length > 0 ? (
        <div className="mt-1 pl-4 text-[10px] text-ink-faint">
          feeds{" "}
          {file.dependents.map((d, i) => (
            <button
              key={d}
              type="button"
              className="font-mono text-ink-muted hover:text-ink"
              onClick={() => onOpenFile(d, 1)}
            >
              {d.split("/").pop()}
              {i < file.dependents.length - 1 ? ", " : ""}
            </button>
          ))}
          {file.importedBy > file.dependents.length ? ` +${file.importedBy - file.dependents.length} more` : ""}
        </div>
      ) : null}
    </div>
  );
}
