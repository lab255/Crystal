import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  Play,
  Umbrella,
} from "lucide-react";
import type { CoverageMetric, CoverageReport, FileCoverage } from "@crystal/core";
import { sumCoverage } from "@crystal/core";
import { requestOpenFile, useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import { EmptyState, Pane as SplitPane, Split, Tooltip, cn, useContextMenu } from "@crystal/ui";
import {
  CoverageBar,
  LensHint,
  PctLabel,
  copyText,
  useQuality,
  useQualityLens,
  type QualityLens,
} from "./common.js";

/**
 * Coverage — the latest istanbul report rendered as an expandable directory
 * tree with banded bars, drilling into per-file metrics and clickable
 * uncovered lines (`#/quality/coverage?path=…`). Works with coverage produced
 * by Crystal's runner or run externally — whatever lands in `coverage/`.
 */

interface CovNode {
  name: string;
  path: string;
  children: CovNode[];
  file: FileCoverage | null;
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
  fileCount: number;
}

function buildTree(files: FileCoverage[]): CovNode {
  const root: CovNode = {
    name: "",
    path: "",
    children: [],
    file: null,
    lines: { covered: 0, total: 0, pct: 100 },
    statements: { covered: 0, total: 0, pct: 100 },
    functions: { covered: 0, total: 0, pct: 100 },
    branches: { covered: 0, total: 0, pct: 100 },
    fileCount: 0,
  };
  const dirs = new Map<string, CovNode>([["", root]]);
  const dirOf = (path: string): CovNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const parent = dirOf(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const node: CovNode = {
      name: path.split("/").at(-1)!,
      path,
      children: [],
      file: null,
      lines: { covered: 0, total: 0, pct: 100 },
      statements: { covered: 0, total: 0, pct: 100 },
      functions: { covered: 0, total: 0, pct: 100 },
      branches: { covered: 0, total: 0, pct: 100 },
      fileCount: 0,
    };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const f of files) {
    const dir = dirOf(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "");
    dir.children.push({
      name: f.path.split("/").at(-1)!,
      path: f.path,
      children: [],
      file: f,
      lines: f.lines,
      statements: f.statements,
      functions: f.functions,
      branches: f.branches,
      fileCount: 1,
    });
  }
  // Collapse single-child directory chains ("packages/core/src" as one row).
  const collapse = (node: CovNode): CovNode => {
    while (node.children.length === 1 && node.children[0]!.file === null && node.file === null && node.path !== "") {
      const only = node.children[0]!;
      node = { ...only, name: node.path === "" ? only.name : `${node.name}/${only.name}` };
    }
    node.children = node.children.map(collapse);
    return node;
  };
  // Roll up metrics bottom-up and sort children (dirs first, then by path).
  const rollup = (node: CovNode): void => {
    if (node.file) return;
    for (const c of node.children) rollup(c);
    node.lines = sumCoverage(node.children.map((c) => c.lines));
    node.statements = sumCoverage(node.children.map((c) => c.statements));
    node.functions = sumCoverage(node.children.map((c) => c.functions));
    node.branches = sumCoverage(node.children.map((c) => c.branches));
    node.fileCount = node.children.reduce((n, c) => n + c.fileCount, 0);
    node.children.sort(
      (a, b) => Number(a.file !== null) - Number(b.file !== null) || a.name.localeCompare(b.name),
    );
  };
  const collapsed = { ...root, children: root.children.map(collapse) };
  rollup(collapsed);
  return collapsed;
}

export function CoverageView() {
  const { coverage, info, liveRun, run } = useQuality();
  const nav = useNavUpdate();
  const selectedPath = useNav((l) => l.quality?.covPath ?? null);
  const find = (useNav((l) => l.quality?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useQualityLens();
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);

  const filtered = useMemo(() => {
    if (!coverage) return null;
    if (!find) return coverage;
    return { ...coverage, files: coverage.files.filter((f) => f.path.toLowerCase().includes(find)) };
  }, [coverage, find]);

  const tree = useMemo(() => (filtered ? buildTree(filtered.files) : null), [filtered]);

  const lensMemberCount = useMemo(
    () => (filtered ? filtered.files.filter((f) => lens.matcher.file(f.path)).length : 0),
    [filtered, lens.matcher],
  );

  // First render of a report: open the top level so the tree isn't a wall of
  // closed folders; explicit user toggles take over from there.
  useEffect(() => {
    if (expanded === null && tree) setExpanded(new Set(tree.children.map((c) => c.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);
  const expandedSet = expanded ?? new Set<string>();

  const selectedFile = coverage?.files.find((f) => f.path === selectedPath) ?? null;
  const running = liveRun != null;

  if (!coverage) {
    return (
      <EmptyState
        icon={Umbrella}
        title="No coverage data yet"
        action={
          info?.coverageCapable ? (
            <button
              type="button"
              disabled={running}
              onClick={() => run({ coverage: true })}
              className="flex items-center gap-1.5 rounded-lg border border-ok/40 bg-ok/10 px-3 py-1.5 text-[11px] font-medium text-ok hover:brightness-110 disabled:opacity-50"
            >
              <Play className="h-3 w-3" /> Run tests with coverage
            </button>
          ) : undefined
        }
      >
        Crystal reads istanbul output from <code>coverage/coverage-final.json</code> — produced by
        a coverage run here or by your own <code>vitest run --coverage</code>.
        {info != null && !info.coverageCapable && info.runner === "vitest" ? (
          <> Install <code>@vitest/coverage-v8</code> to run coverage from Crystal.</>
        ) : null}
      </EmptyState>
    );
  }

  const toggle = (path: string) =>
    setExpanded((e) => {
      const next = new Set(e ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const nodeMenu = (node: CovNode): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: node.path || "workspace" },
    ...(node.file?.uncoveredLines?.length
      ? [
          {
            type: "item" as const,
            label: "Open first uncovered line",
            icon: ExternalLink,
            hint: `:${node.file.uncoveredLines[0]}`,
            onSelect: () => requestOpenFile(node.path, node.file!.uncoveredLines![0]),
          },
        ]
      : []),
    // Shared cross-view block; "quality" omitted — this *is* the coverage view.
    // Directories get module semantics (code-map drill + copy path).
    ...symbolMenu(node.file ? { file: node.path } : { module: node.path }, {
      omit: ["quality"],
    }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* totals bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge bg-surface-1 px-3 py-1.5">
        {(
          [
            ["Lines", coverage.total.lines],
            ["Statements", coverage.total.statements],
            ["Functions", coverage.total.functions],
            ["Branches", coverage.total.branches],
          ] as const
        ).map(([label, metric]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
            <PctLabel metric={metric} className="text-[11px]" />
            <CoverageBar metric={metric} className="w-16" />
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <Tooltip content="When the coverage data was produced">
            <span className="text-[10px] text-ink-faint">
              {new Date(coverage.generatedAt).toLocaleString()}
            </span>
          </Tooltip>
          {info?.coverageCapable ? (
            <button
              type="button"
              disabled={running}
              onClick={() => run({ coverage: true })}
              className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink disabled:opacity-50"
            >
              <Play className="h-3 w-3 text-ok" /> Re-run
            </button>
          ) : null}
        </span>
      </div>

      <Split storageKey="quality:coverage" direction="horizontal" className="min-h-0 flex-1">
        <SplitPane defaultSize={420} minSize={280} maxSize={640}>
          <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
            <div className="flex items-center gap-2 px-3 py-2">
              <Umbrella className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Coverage tree
              </span>
              <span className="text-[10px] text-ink-faint">{tree?.fileCount ?? 0} files</span>
              <LensHint
                lens={lens}
                member={lensMemberCount}
                total={tree?.fileCount ?? 0}
                noun="files"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {tree?.children.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expandedSet}
                  autoExpand={find.length > 0}
                  selectedPath={selectedPath}
                  lens={lens}
                  onToggle={toggle}
                  onSelect={(p) => nav({ quality: { covPath: p } })}
                  onContextMenu={(e, n) => menu.open(e, nodeMenu(n))}
                />
              ))}
              {tree && tree.children.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-ink-faint">
                  Nothing matches the current filter.
                </div>
              ) : null}
            </div>
          </aside>
        </SplitPane>
        <SplitPane minSize="35%">
          {selectedFile ? (
            <FileCoverageDetail key={selectedFile.path} file={selectedFile} />
          ) : (
            <EmptyState icon={Umbrella} title="Pick a file">
              Its four coverage metrics and every uncovered line, one click from the editor.
            </EmptyState>
          )}
        </SplitPane>
        {menu.element}
      </Split>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  autoExpand,
  selectedPath,
  lens,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  node: CovNode;
  depth: number;
  expanded: ReadonlySet<string>;
  /** Find active: open everything so hits are visible. */
  autoExpand: boolean;
  selectedPath: string | null;
  lens: QualityLens;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: CovNode) => void;
}) {
  const isDir = node.file === null;
  const open = autoExpand || expanded.has(node.path);
  // Lens-relevant: a member file, or a directory the lens touches.
  const inLens = isDir ? lens.matcher.under(node.path) : lens.matcher.file(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        onContextMenu={(e) => onContextMenu(e, node)}
        aria-expanded={isDir ? open : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left",
          selectedPath === node.path
            ? "bg-crystal-500/15 text-ink"
            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
          // Outside the lens: dimmed but present, same as find elsewhere.
          lens.dimming && !inLens && "opacity-40",
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={cn("h-3 w-3 shrink-0 text-ink-faint transition-transform", open && "rotate-90")}
            />
            {open ? (
              <FolderOpen className="h-3 w-3 shrink-0 text-accent-amber/70" />
            ) : (
              <Folder className="h-3 w-3 shrink-0 text-accent-amber/70" />
            )}
          </>
        ) : (
          <FileCode2 className="ml-[18px] h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">{node.name}</span>
        {isDir ? (
          <span className="shrink-0 font-mono text-[9px] text-ink-faint">{node.fileCount}</span>
        ) : null}
        <CoverageBar metric={node.lines} className="w-14 shrink-0" />
        <PctLabel metric={node.lines} className="w-11 shrink-0 text-right" />
      </button>
      {isDir && open
        ? node.children.map((c) => (
            <TreeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              autoExpand={autoExpand}
              selectedPath={selectedPath}
              lens={lens}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  );
}

/** Consecutive line numbers → "12–15" ranges for compact chips. */
function lineRanges(lines: number[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else ranges.push({ from: n, to: n });
  }
  return ranges;
}

function FileCoverageDetail({ file }: { file: FileCoverage }) {
  const ranges = useMemo(() => lineRanges(file.uncoveredLines ?? []), [file.uncoveredLines]);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-accent-cyan" />
          <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] font-semibold text-ink">
            {file.path}
          </span>
          <Tooltip content="Open in the editor">
            <button
              type="button"
              onClick={() => requestOpenFile(file.path)}
              className="shrink-0 rounded-md border border-edge bg-surface-2 p-1 text-ink-muted hover:text-ink"
              aria-label="Open in editor"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ["Lines", file.lines],
              ["Statements", file.statements],
              ["Functions", file.functions],
              ["Branches", file.branches],
            ] as const
          ).map(([label, metric]) => (
            <div key={label} className="rounded-lg border border-edge bg-surface-2 p-2">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[9.5px] uppercase tracking-wider text-ink-faint">{label}</span>
                <PctLabel metric={metric} className="text-[12px]" />
              </div>
              <CoverageBar metric={metric} />
              <div className="mt-1 font-mono text-[9px] text-ink-faint">
                {metric.covered}/{metric.total}
              </div>
            </div>
          ))}
        </div>
      </div>

      <section className="px-4 py-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Uncovered lines · {file.uncoveredLines?.length ?? 0}
        </h3>
        {!file.uncoveredLines || file.uncoveredLines.length === 0 ? (
          <div className="text-[11px] text-ok">Every measured line is covered. 🎉</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {ranges.map((r) => (
              <Tooltip
                key={r.from}
                content={`Open ${file.path.split("/").at(-1)} at line ${r.from}`}
              >
                <button
                  type="button"
                  onClick={() => requestOpenFile(file.path, r.from)}
                  className="rounded-md border border-danger/30 bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] text-danger hover:brightness-110"
                >
                  {r.from === r.to ? r.from : `${r.from}–${r.to}`}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
