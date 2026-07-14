import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  FlaskConical,
  History,
  Play,
  Square,
  Umbrella,
} from "lucide-react";
import type { QualityRun, TestCaseResult, TestFileResult } from "@crystal/core";
import { requestOpenFile, useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import { Badge, EmptyState, Pane as SplitPane, Split, Tooltip, cn, useContextMenu } from "@crystal/ui";
import { StatusIcon, copyText, fmtDuration, fmtTime, useQuality } from "./common.js";

/**
 * Tests — the workspace's own test suite, run from inside Crystal. The file
 * list merges discovered test files with the selected run's results; every
 * file and test is runnable in isolation, failures unfold in place, and the
 * selection deep-links (`#/quality/tests?file=…&test=…&run=…`).
 */

interface FileRow {
  file: string;
  result: TestFileResult | null;
}

export function TestsView() {
  const { info, runs, liveRun, error, run, cancel } = useQuality();
  const nav = useNavUpdate();
  const selectedFile = useNav((l) => l.quality?.file ?? null);
  const selectedTest = useNav((l) => l.quality?.test ?? null);
  const selectedRunId = useNav((l) => l.quality?.run ?? null);
  const find = (useNav((l) => l.quality?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();

  // The run everything renders against: explicit selection, else live, else latest.
  const shownRun: QualityRun | null =
    runs.find((r) => r.id === selectedRunId) ?? liveRun ?? runs[0] ?? null;

  const rows = useMemo<FileRow[]>(() => {
    const byFile = new Map<string, TestFileResult>();
    for (const f of shownRun?.files ?? []) byFile.set(f.file, f);
    const known = new Set<string>([...(info?.testFiles ?? []), ...byFile.keys()]);
    return [...known]
      .sort()
      .map((file) => ({ file, result: byFile.get(file) ?? null }))
      .filter((r) => !find || r.file.toLowerCase().includes(find));
  }, [info, shownRun, find]);

  const failedFirst = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const rank = (r: FileRow) => (r.result?.status === "fail" ? 0 : r.result ? 1 : 2);
        return rank(a) - rank(b) || a.file.localeCompare(b.file);
      }),
    [rows],
  );

  const selected = rows.find((r) => r.file === selectedFile) ?? null;

  if (info && info.runner === null) {
    return (
      <EmptyState icon={FlaskConical} title="No test setup detected">
        Crystal looks for a vitest/jest config (or dependency) and a package.json `test` script
        at the workspace root and in every workspace package. Add one and the runner appears
        here.
      </EmptyState>
    );
  }

  const running = liveRun != null;

  const fileMenu = (r: FileRow): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: r.file.split("/").at(-1) ?? r.file },
    {
      type: "item",
      label: "Run this file",
      icon: Play,
      disabled: running,
      onSelect: () => run({ file: r.file }),
    },
    {
      type: "item",
      label: "Run with coverage",
      icon: Umbrella,
      disabled: running || !info?.coverageCapable,
      onSelect: () => run({ file: r.file, coverage: true }),
    },
    { type: "separator" },
    // Shared cross-view block; "quality" omitted — this *is* the test runner.
    ...symbolMenu({ file: r.file }, { omit: ["quality"] }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* run bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
        {running ? (
          <button
            type="button"
            onClick={() => cancel(liveRun!.id)}
            className="flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger hover:brightness-110"
          >
            <Square className="h-3 w-3" /> Cancel run
          </button>
        ) : (
          <>
            <Tooltip
              content={
                info?.runner
                  ? `Run every test with ${info.runner}`
                  : "Detecting the test runner…"
              }
            >
              <button
                type="button"
                disabled={!info?.runner}
                onClick={() => run({})}
                className="flex items-center gap-1.5 rounded-lg border border-ok/40 bg-ok/10 px-2.5 py-1 text-[11px] font-medium text-ok hover:brightness-110 disabled:opacity-50"
              >
                <Play className="h-3 w-3" /> Run all
              </button>
            </Tooltip>
            <Tooltip
              content={
                info?.coverageCapable
                  ? "Run every test and collect coverage"
                  : info?.runner === "vitest"
                    ? "Install @vitest/coverage-v8 to enable coverage"
                    : "This runner cannot collect coverage from Crystal"
              }
            >
              <button
                type="button"
                disabled={!info?.coverageCapable}
                onClick={() => run({ coverage: true })}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
              >
                <Umbrella className="h-3 w-3" /> With coverage
              </button>
            </Tooltip>
          </>
        )}
        {shownRun ? <RunSummaryChip run={shownRun} /> : null}
        {error ? (
          <span className="min-w-0 truncate text-[10.5px] text-danger" title={error}>
            {error}
          </span>
        ) : null}
        <span className="ml-auto" />
        {runs.length > 0 ? (
          <RunPicker
            runs={runs}
            shownRun={shownRun}
            onPick={(id) => nav({ quality: { run: id } })}
          />
        ) : null}
        {info?.runner ? (
          <Tooltip
            content={
              info.packages.length > 1
                ? `${info.packages.length} packages run their own tests: ${info.packages
                    .map((p) => (p.dir === "." ? "root" : p.dir))
                    .join(", ")}`
                : (info.configFile ?? info.script ?? "detected from package.json")
            }
          >
            <Badge tone="slate">
              {info.runner}
              {info.packages.length > 1 ? ` · ${info.packages.length} pkgs` : ""}
            </Badge>
          </Tooltip>
        ) : null}
      </div>

      <Split storageKey="quality:tests" direction="horizontal" className="min-h-0 flex-1">
        <SplitPane defaultSize={340} minSize={240} maxSize={560}>
          <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
            <div className="flex items-center gap-2 px-3 py-2">
              <FlaskConical className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Test files
              </span>
              <span className="text-[10px] text-ink-faint">{rows.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {failedFirst.map((r) => {
                const isRunning =
                  running && (liveRun!.scope.file == null || liveRun!.scope.file === r.file) && !r.result;
                return (
                  <button
                    key={r.file}
                    type="button"
                    onClick={() => nav({ quality: { file: r.file, test: null } })}
                    onContextMenu={(e) => menu.open(e, fileMenu(r))}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                      selected?.file === r.file
                        ? "bg-crystal-500/15 text-ink"
                        : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <StatusIcon status={r.result?.status ?? null} running={isRunning} className="h-3 w-3" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">{r.file}</span>
                    {r.result ? (
                      <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                        {fmtDuration(r.result.durationMs)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-ink-faint">
                  {find ? "Nothing matches the current filter." : "No test files found."}
                </div>
              ) : null}
            </div>
          </aside>
        </SplitPane>
        <SplitPane minSize="40%">
          {selected ? (
            <FileDetail
              key={selected.file}
              row={selected}
              running={running}
              coverageCapable={info?.coverageCapable ?? false}
              selectedTest={selectedTest}
              onSelectTest={(t) => nav({ quality: { test: t } })}
              onRun={run}
            />
          ) : shownRun?.status === "error" ? (
            <div className="flex h-full flex-col gap-2 overflow-y-auto p-4">
              <div className="text-sm font-medium text-danger">The runner failed to start</div>
              <pre className="overflow-x-auto rounded-lg border border-edge bg-surface-1 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted">
                {shownRun.error ?? "No output captured."}
              </pre>
            </div>
          ) : (
            <EmptyState icon={FlaskConical} title="Pick a test file">
              Its tests with pass/fail status and timings; failures unfold with their message,
              diff and stack. Right-click any file to run it alone.
            </EmptyState>
          )}
        </SplitPane>
        {menu.element}
      </Split>
    </div>
  );
}

/** passed/failed/skipped counts + duration for the run bar. */
function RunSummaryChip({ run }: { run: QualityRun }) {
  const s = run.summary;
  if (run.status === "running") {
    const done = run.files.length;
    return (
      <span className="flex items-center gap-1.5 text-[10.5px] text-info">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
        running{done > 0 ? ` · ${done} file${done === 1 ? "" : "s"} in` : "…"}
      </span>
    );
  }
  if (run.status === "cancelled")
    return <span className="text-[10.5px] text-ink-faint">cancelled at {fmtTime(run.startedAt)}</span>;
  if (run.status === "error")
    return <span className="text-[10.5px] text-danger">runner error — see details</span>;
  if (!s) return null;
  return (
    <Tooltip content={`started ${fmtTime(run.startedAt)}${run.scope.file ? ` · ${run.scope.file}` : ""}`}>
      <span className="flex items-center gap-2 text-[10.5px] tabular-nums">
        <span className="text-ok">{s.passed} passed</span>
        {s.failed > 0 ? <span className="text-danger">{s.failed} failed</span> : null}
        {s.skipped > 0 ? <span className="text-ink-faint">{s.skipped} skipped</span> : null}
        <span className="text-ink-faint">{fmtDuration(s.durationMs)}</span>
      </span>
    </Tooltip>
  );
}

/** Recent-run dropdown — selecting one re-renders results against it. */
function RunPicker({
  runs,
  shownRun,
  onPick,
}: {
  runs: QualityRun[];
  shownRun: QualityRun | null;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Tooltip content="Recent runs">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink"
        >
          <History className="h-3 w-3" />
          {shownRun ? fmtTime(shownRun.startedAt) : "runs"}
          <ChevronDown className="h-3 w-3" />
        </button>
      </Tooltip>
      {open ? (
        <div className="absolute right-0 top-full z-40 mt-1 max-h-64 w-64 overflow-y-auto rounded-xl border border-edge bg-surface-2/98 p-1 shadow-2xl shadow-black/50 backdrop-blur">
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onPick(r.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10.5px]",
                r.id === shownRun?.id ? "bg-surface-active text-ink" : "text-ink-muted hover:bg-surface-active",
              )}
            >
              <StatusIcon
                status={r.status === "passed" ? "pass" : r.status === "failed" ? "fail" : null}
                running={r.status === "running"}
                className="h-3 w-3"
              />
              <span className="flex-1">
                {fmtTime(r.startedAt)}
                {r.scope.file ? ` · ${r.scope.file.split("/").at(-1)}` : " · all"}
                {r.scope.testName ? ` · "${r.scope.testName}"` : ""}
              </span>
              {r.withCoverage ? <Umbrella className="h-3 w-3 shrink-0 text-ink-faint" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* File detail: the tests inside one file                              */
/* ------------------------------------------------------------------ */

function FileDetail({
  row,
  running,
  coverageCapable,
  selectedTest,
  onSelectTest,
  onRun,
}: {
  row: FileRow;
  running: boolean;
  coverageCapable: boolean;
  selectedTest: string | null;
  onSelectTest: (test: string | null) => void;
  onRun: (params: { file?: string; testName?: string; coverage?: boolean }) => void;
}) {
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const tests = row.result?.tests ?? [];

  const testMenu = (t: TestCaseResult): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: t.name },
    {
      type: "item",
      label: "Run this test",
      icon: Play,
      disabled: running,
      onSelect: () => onRun({ file: row.file, testName: lastSegment(t.name) }),
    },
    { type: "separator" },
    // Shared cross-view block — "Open in editor" jumps to the failure line.
    ...symbolMenu({ file: row.file, line: t.error?.line, label: t.name }, { omit: ["quality"] }),
    {
      type: "item",
      label: "Copy test name",
      icon: Copy,
      onSelect: () => copyText(t.name),
    },
    ...(t.error
      ? [
          {
            type: "item" as const,
            label: "Copy failure message",
            icon: Copy,
            onSelect: () => copyText(t.error!.message),
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusIcon status={row.result?.status ?? null} />
          <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] font-semibold text-ink">
            {row.file}
          </span>
          <Tooltip content="Open in the editor">
            <button
              type="button"
              onClick={() => requestOpenFile(row.file)}
              className="shrink-0 rounded-md border border-edge bg-surface-2 p-1 text-ink-muted hover:text-ink"
              aria-label="Open in editor"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={running}
            onClick={() => onRun({ file: row.file })}
            className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted hover:text-ink disabled:opacity-50"
          >
            <Play className="h-3 w-3 text-ok" /> Run file
          </button>
          {coverageCapable ? (
            <button
              type="button"
              disabled={running}
              onClick={() => onRun({ file: row.file, coverage: true })}
              className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted hover:text-ink disabled:opacity-50"
            >
              <Umbrella className="h-3 w-3" /> With coverage
            </button>
          ) : null}
          {row.result ? (
            <span className="text-[10px] text-ink-faint">
              {tests.length} test{tests.length === 1 ? "" : "s"} · {fmtDuration(row.result.durationMs)}
            </span>
          ) : (
            <span className="text-[10px] text-ink-faint">not in the selected run yet</span>
          )}
        </div>
      </div>

      <div className="flex-1 px-2 py-2">
        {tests.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-ink-faint">
            {row.result
              ? "The reporter returned no tests for this file."
              : "Run the file (or the suite) to see its tests here."}
          </div>
        ) : (
          <div className="space-y-0.5">
            {tests.map((t) => (
              <TestRow
                key={t.name}
                test={t}
                file={row.file}
                selected={selectedTest === t.name}
                onSelect={() => onSelectTest(selectedTest === t.name ? null : t.name)}
                onContextMenu={(e) => menu.open(e, testMenu(t))}
              />
            ))}
          </div>
        )}
      </div>
      {menu.element}
    </div>
  );
}

/** "suite > nested > name" → "name" (the `-t` filter target). */
function lastSegment(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

function TestRow({
  test: t,
  file,
  selected,
  onSelect,
  onContextMenu,
}: {
  test: TestCaseResult;
  file: string;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  // Failures start open; passing tests are a single row.
  const [dismissed, setDismissed] = useState(false);
  const expandable = t.error != null;
  const open = expandable && (selected || (t.status === "fail" && !dismissed));
  const segments = t.name.split(" > ");

  return (
    <div
      className={cn(
        "rounded-lg",
        selected && "bg-crystal-500/10",
        t.status === "fail" && !selected && "bg-danger/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={() => {
          // Toggle: selecting opens; deselecting also collapses an auto-opened failure.
          setDismissed(selected);
          onSelect();
        }}
        onContextMenu={onContextMenu}
        aria-expanded={expandable ? open : undefined}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-surface-2/60"
      >
        <StatusIcon status={t.status} className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
          {segments.length > 1 ? (
            <span className="text-ink-faint">{segments.slice(0, -1).join(" › ")} › </span>
          ) : null}
          <span className={cn(t.status === "fail" ? "text-danger" : "text-ink")}>
            {segments[segments.length - 1]}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[9px] text-ink-faint">
          {fmtDuration(t.durationMs)}
        </span>
        {expandable ? (
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 text-ink-faint transition-transform", open && "rotate-180")}
          />
        ) : null}
      </button>
      {expandable && open ? (
        <div className="mx-2 mb-1.5 space-y-1.5 rounded-lg border border-danger/25 bg-danger/[0.06] p-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-danger/90">
            {t.error!.message}
          </pre>
          {t.error!.expected != null || t.error!.actual != null ? (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-ok/25 bg-ok/[0.06] p-1.5">
                <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-ok">
                  Expected
                </div>
                <pre className="overflow-x-auto font-mono text-[10px] text-ink-muted">
                  {t.error!.expected ?? "—"}
                </pre>
              </div>
              <div className="rounded-md border border-danger/25 bg-danger/[0.06] p-1.5">
                <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-danger">
                  Received
                </div>
                <pre className="overflow-x-auto font-mono text-[10px] text-ink-muted">
                  {t.error!.actual ?? "—"}
                </pre>
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => requestOpenFile(file, t.error!.line)}
              className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            >
              <ExternalLink className="h-3 w-3" />
              {t.error!.line != null ? `Open at line ${t.error!.line}` : "Open test file"}
            </button>
            {t.error!.stack ? (
              <Tooltip content={t.error!.stack}>
                <span className="min-w-0 truncate font-mono text-[9.5px] text-ink-faint">
                  {t.error!.stack}
                </span>
              </Tooltip>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
