import { useCallback, useEffect, useMemo, useState } from "react";
import { Flame, FolderGit2, RotateCcw, TableProperties } from "lucide-react";
import {
  TRACES_DIR,
  buildFlameTree,
  flameTreeFromCodeTrace,
  layerOfNode,
  parseCrystalFile,
  type ArchLayer,
  type ArchitectureGraph,
  type CodeMapSummary,
  type CodeTrace,
  type CodeTraceStep,
  type FlameNode,
  type FileEntry,
  type TraceProfile,
} from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Tooltip, cn, type BadgeTone } from "@crystal/ui";
import { linkNodesToModules } from "./overlay.js";

/**
 * Journey profile — the bottom pane under the canvas while a journey lens is
 * active. Two views over the same journey:
 *
 *   flame — a flamegraph of the call tree. Defaults to the static call graph
 *           (weight = reachable symbols); runtime trace profiles dropped in
 *           `.crystal/traces/` overlay real sampled/timed executions.
 *   calls — what-calls-what: per-symbol fan-in/out and the module-to-module
 *           hops of the journey, entry → service → data.
 */

const ROW_H = 20;
const ROW_GAP = 1;
/** Frames narrower than this fraction of the view are dropped from render. */
const MIN_FRACTION = 0.003;

const FRAME_ACCENTS = [
  "var(--color-accent-violet)",
  "var(--color-accent-cyan)",
  "var(--color-accent-emerald)",
  "var(--color-accent-amber)",
  "var(--color-accent-rose)",
  "var(--color-accent-blue)",
  "var(--color-accent-slate)",
] as const;

function accentFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FRAME_ACCENTS[h % FRAME_ACCENTS.length]!;
}

const LAYER_TONE: Record<ArchLayer, BadgeTone> = {
  entry: "cyan",
  service: "violet",
  data: "emerald",
};

export function JourneyProfilePanel({
  trace,
  graph,
  summary,
  onOpenStep,
  onSelectStep,
}: {
  trace: CodeTrace;
  graph: ArchitectureGraph;
  summary: CodeMapSummary | null;
  /** "Open in code map" for one step/frame. */
  onOpenStep?: (step: CodeTraceStep) => void;
  /** Single click on a frame/row — point at the component on the canvas. */
  onSelectStep?: (step: CodeTraceStep) => void;
}) {
  const { client } = useCrystal();
  const [view, setView] = useState<"flame" | "calls">("flame");
  const [profiles, setProfiles] = useState<FileEntry[]>([]);
  const [profilePath, setProfilePath] = useState<string | null>(null);
  const [profile, setProfile] = useState<TraceProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .request("fs.list", { path: TRACES_DIR })
      .then(({ entries }) => {
        if (cancelled) return;
        setProfiles(entries.filter((e) => e.kind === "file" && e.name.endsWith(".json")));
      })
      .catch(() => !cancelled && setProfiles([])); // No traces dir yet.
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!profilePath) {
      setProfile(null);
      setProfileError(null);
      return;
    }
    let cancelled = false;
    client
      .request("fs.read", { path: profilePath })
      .then(({ content }) => {
        if (cancelled) return;
        setProfile(parseCrystalFile("trace", content));
        setProfileError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setProfile(null);
        setProfileError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, profilePath]);

  const staticRoot = useMemo(() => flameTreeFromCodeTrace(trace), [trace]);
  const runtimeRoots = useMemo(() => (profile ? buildFlameTree(profile) : null), [profile]);

  const { root, unit } = useMemo(() => {
    if (runtimeRoots && runtimeRoots.length > 0 && profile) {
      if (runtimeRoots.length === 1) return { root: runtimeRoots[0]!, unit: profile.unit };
      const total = runtimeRoots.reduce((s, r) => s + r.total, 0);
      const all: FlameNode = {
        name: profile.name,
        file: null,
        symbol: null,
        total,
        self: 0,
        calls: null,
        depth: -1,
        children: runtimeRoots,
      };
      return { root: all, unit: profile.unit };
    }
    return { root: staticRoot, unit: "symbols" as const };
  }, [runtimeRoots, profile, staticRoot]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <ProfileTab
            active={view === "flame"}
            onClick={() => setView("flame")}
            icon={<Flame className="h-3 w-3" />}
            label="Flame graph"
          />
          <ProfileTab
            active={view === "calls"}
            onClick={() => setView("calls")}
            icon={<TableProperties className="h-3 w-3" />}
            label="Call profile"
          />
        </div>
        {view === "flame" ? (
          <>
            <select
              value={profilePath ?? ""}
              onChange={(e) => setProfilePath(e.target.value || null)}
              className="max-w-56 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted outline-none"
              aria-label="Trace source"
            >
              <option value="">Static call graph</option>
              {profiles.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-ink-faint">
              {profilePath
                ? profileError
                  ? null
                  : `runtime · ${unit}`
                : "weights = symbols reached; drop runtime profiles in " + TRACES_DIR + "/"}
            </span>
            {profileError ? (
              <span className="truncate text-[10px] text-danger">{profileError}</span>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "flame" ? (
          root ? (
            <FlameGraph
              root={root}
              unit={unit}
              onOpenFrame={onOpenStep}
              onSelectFrame={onSelectStep}
              trace={trace}
            />
          ) : (
            <div className="p-3 text-[11px] text-ink-faint">Nothing to graph yet.</div>
          )
        ) : (
          <CallProfile
            trace={trace}
            graph={graph}
            summary={summary}
            onOpenStep={onOpenStep}
            onSelectStep={onSelectStep}
          />
        )}
      </div>
    </div>
  );
}

function ProfileTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors",
        active ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {icon} {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Flamegraph                                                          */
/* ------------------------------------------------------------------ */

interface FrameRect {
  node: FlameNode;
  left: number; // fraction of the focused width
  width: number;
  row: number;
}

function FlameGraph({
  root,
  unit,
  trace,
  onOpenFrame,
  onSelectFrame,
}: {
  root: FlameNode;
  unit: string;
  trace: CodeTrace;
  onOpenFrame?: (step: CodeTraceStep) => void;
  /** Single click — zooms the flamegraph AND points at the component. */
  onSelectFrame?: (step: CodeTraceStep) => void;
}) {
  const [focus, setFocus] = useState<FlameNode>(root);
  useEffect(() => setFocus(root), [root]);

  const stepByKey = useMemo(
    () => new Map(trace.steps.map((s) => [`${s.ref.file}#${s.ref.symbol}`, s])),
    [trace],
  );

  const rects = useMemo(() => {
    const out: FrameRect[] = [];
    const walk = (node: FlameNode, left: number, row: number) => {
      const width = node.total / focus.total;
      if (width < MIN_FRACTION) return;
      out.push({ node, left, width, row });
      let childLeft = left;
      for (const child of node.children) {
        walk(child, childLeft, row + 1);
        childLeft += child.total / focus.total;
      }
    };
    walk(focus, 0, 0);
    return out;
  }, [focus]);

  const rows = rects.reduce((m, r) => Math.max(m, r.row), 0) + 1;
  const fmt = (v: number) =>
    unit === "milliseconds" ? `${v.toFixed(1)} ms` : unit === "microseconds" ? `${v} µs` : `${v} ${unit}`;

  return (
    <div className="p-2">
      {focus !== root ? (
        <button
          type="button"
          onClick={() => setFocus(root)}
          className="mb-1.5 flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink"
        >
          <RotateCcw className="h-3 w-3" /> Reset zoom — {focus.name}
        </button>
      ) : null}
      <div
        className="relative min-w-full"
        style={{ height: rows * (ROW_H + ROW_GAP) }}
        role="figure"
        aria-label="Flamegraph of the journey call tree"
      >
        {rects.map((r) => {
          const key = r.node.file ? `${r.node.file}#${r.node.symbol ?? r.node.name}` : r.node.name;
          const step = r.node.file && r.node.symbol ? stepByKey.get(`${r.node.file}#${r.node.symbol}`) : undefined;
          const pct = ((r.node.total / root.total) * 100).toFixed(1);
          return (
            <button
              key={`${key}:${r.row}:${r.left.toFixed(6)}`}
              type="button"
              onClick={() => {
                setFocus(r.node);
                if (step) onSelectFrame?.(step);
              }}
              onDoubleClick={() => step && onOpenFrame?.(step)}
              title={`${r.node.name} — ${fmt(r.node.total)} total (${pct}%), ${fmt(r.node.self)} self${r.node.calls != null ? `, ×${r.node.calls} calls` : ""}${r.node.file ? `\n${r.node.file}` : ""}${step && onSelectFrame ? "\nClick: show on the diagram" : ""}${step && onOpenFrame ? "\nDouble-click: open in code map" : ""}`}
              className="absolute overflow-hidden whitespace-nowrap rounded-[3px] border border-black/20 px-1 text-left font-mono text-[10px] leading-[18px] text-black/75 transition-[filter] hover:brightness-110"
              style={{
                left: `${r.left * 100}%`,
                width: `calc(${r.width * 100}% - 1px)`,
                top: r.row * (ROW_H + ROW_GAP),
                height: ROW_H,
                background: accentFor(fileModuleKey(r.node)),
              }}
            >
              {r.width > 0.03 ? r.node.name : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Color frames by owning file (falls back to name) so siblings from the same file read as one hue. */
function fileModuleKey(node: FlameNode): string {
  if (!node.file) return node.name;
  const dir = node.file.split("/").slice(0, -1).join("/");
  return dir || node.file;
}

/* ------------------------------------------------------------------ */
/* Call profile (what calls what)                                      */
/* ------------------------------------------------------------------ */

function CallProfile({
  trace,
  graph,
  summary,
  onOpenStep,
  onSelectStep,
}: {
  trace: CodeTrace;
  graph: ArchitectureGraph;
  summary: CodeMapSummary | null;
  onOpenStep?: (step: CodeTraceStep) => void;
  /** Row click — point at the component on the canvas. */
  onSelectStep?: (step: CodeTraceStep) => void;
}) {
  const key = (ref: { file: string; symbol: string }) => `${ref.file}#${ref.symbol}`;

  const { fanIn, fanOut } = useMemo(() => {
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();
    for (const e of trace.edges) {
      fanOut.set(key(e.from), (fanOut.get(key(e.from)) ?? 0) + 1);
      fanIn.set(key(e.to), (fanIn.get(key(e.to)) ?? 0) + 1);
    }
    return { fanIn, fanOut };
  }, [trace]);

  // Module → module call counts along the journey (what layer calls what).
  const moduleFlows = useMemo(() => {
    const moduleOf = new Map(trace.steps.map((s) => [key(s.ref), s.module]));
    const counts = new Map<string, number>();
    for (const e of trace.edges) {
      const a = moduleOf.get(key(e.from));
      const b = moduleOf.get(key(e.to));
      if (!a || !b || a === b) continue;
      const k = `${a} → ${b}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1]);
  }, [trace]);

  // Step → diagram layer, via the same node linking the flow lens uses.
  const layerOfStep = useMemo(() => {
    const fileToNode = new Map<string, ArchLayer | null>();
    const moduleToNode = new Map<string, ArchLayer | null>();
    for (const node of graph.nodes) {
      if (node.codeFile && !fileToNode.has(node.codeFile)) {
        fileToNode.set(node.codeFile, layerOfNode(node));
      }
    }
    if (summary) {
      for (const [nodeId, badge] of linkNodesToModules(graph, summary)) {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (node && !moduleToNode.has(badge.module)) {
          moduleToNode.set(badge.module, layerOfNode(node));
        }
      }
    }
    return (step: CodeTraceStep): ArchLayer | null =>
      fileToNode.get(step.ref.file) ?? moduleToNode.get(step.module) ?? null;
  }, [graph, summary]);

  return (
    <div className="p-3">
      {moduleFlows.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {moduleFlows.map(([flow, count]) => (
            <span
              key={flow}
              className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-ink-muted"
            >
              {flow} <span className="text-ink-faint">×{count}</span>
            </span>
          ))}
        </div>
      ) : null}
      <table className="w-full border-separate border-spacing-0 text-left text-[11px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-ink-faint">
            <th className="border-b border-edge px-1.5 pb-1 font-medium">Symbol</th>
            <th className="border-b border-edge px-1.5 pb-1 font-medium">Module</th>
            <th className="border-b border-edge px-1.5 pb-1 font-medium">Layer</th>
            <th className="border-b border-edge px-1.5 pb-1 text-right font-medium">Depth</th>
            <th className="border-b border-edge px-1.5 pb-1 text-right font-medium">
              <Tooltip content="Resolved callers within this trace">
                <span>In</span>
              </Tooltip>
            </th>
            <th className="border-b border-edge px-1.5 pb-1 text-right font-medium">
              <Tooltip content="Resolved calls out of this symbol">
                <span>Out</span>
              </Tooltip>
            </th>
            <th className="border-b border-edge pb-1" />
          </tr>
        </thead>
        <tbody>
          {trace.steps.map((step) => {
            const k = key(step.ref);
            const layer = layerOfStep(step);
            return (
              <tr
                key={k}
                className={cn("group hover:bg-surface-2", onSelectStep && "cursor-pointer")}
                onClick={() => onSelectStep?.(step)}
                title={onSelectStep ? "Show on the diagram" : undefined}
              >
                <td className="max-w-64 truncate px-1.5 py-0.5 font-mono text-ink" title={step.ref.file}>
                  <span style={{ paddingLeft: Math.min(step.depth, 6) * 8 }}>{step.ref.symbol}</span>
                </td>
                <td className="max-w-40 truncate px-1.5 py-0.5 text-ink-faint">{step.module}</td>
                <td className="px-1.5 py-0.5">
                  {layer ? <Badge tone={LAYER_TONE[layer]}>{layer}</Badge> : null}
                </td>
                <td className="px-1.5 py-0.5 text-right tabular-nums text-ink-muted">{step.depth}</td>
                <td className="px-1.5 py-0.5 text-right tabular-nums text-ink-muted">
                  {fanIn.get(k) ?? 0}
                </td>
                <td className="px-1.5 py-0.5 text-right tabular-nums text-ink-muted">
                  {fanOut.get(k) ?? 0}
                </td>
                <td className="w-6 py-0.5">
                  {onOpenStep ? (
                    <Tooltip content="Open in code map">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenStep(step);
                        }}
                        className="text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
                        aria-label={`Open ${step.ref.symbol} in code map`}
                      >
                        <FolderGit2 className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trace.unresolvedCalls.length > 0 ? (
        <div className="mt-2 text-[10px] text-ink-faint">
          {trace.unresolvedCalls.length} dynamic/instance-method call
          {trace.unresolvedCalls.length > 1 ? "s" : ""} could not be traced.
        </div>
      ) : null}
    </div>
  );
}
