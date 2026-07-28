import { useMemo } from "react";
import { Coins } from "lucide-react";
import {
  costSlices,
  tagDimensions,
  type CostAxis,
  type CostSlice,
  type Project,
} from "@crystal/core";
import {
  formatRunCost,
  formatRunTokens,
  useAgents,
  useWorkspace,
  useWorkflows,
} from "@crystal/client";
import { EmptyState, StatusDot, cn } from "@crystal/ui";

/**
 * Cost attribution: the workspace's spend sliced along one axis — epic,
 * human owner, workflow, agent profile, or any tag dimension the board's
 * labels carry (multi-dimensional: a task tagged `area:ui` and `area:db`
 * bills both slices in full — a lens, not a partition). The fold itself is
 * pure core ({@link costSlices}); this component renders rows of one measure
 * ($), so bars stay single-hue and identity lives in the row label, with the
 * per-model split as muted text rather than a categorical stack.
 */
export function CostsTab({
  project,
  axis,
  onAxisChange,
}: {
  project: Project | null;
  /** Deep-linked axis (`costBy` param): "epic" | "human" | "workflow" | "agent" | "tag:<dim>". */
  axis: string | null;
  onAxisChange: (axis: string) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const workflows = useWorkflows((s) => s.workflows);
  const roster = useWorkspace((s) => s.roster);

  // Axes on offer: the three fixed ones plus every tag dimension the board
  // actually uses — discovered, not configured.
  const dimensions = useMemo(
    () => (project ? tagDimensions(project.tasks.flatMap((t) => t.labels)) : []),
    [project],
  );
  const active: CostAxis = useMemo(() => {
    if (axis === "human" || axis === "workflow" || axis === "agent") return axis;
    // A tag axis must name a dimension the board actually uses — a stale
    // deep link would otherwise render slices with no chip selected.
    if (axis?.startsWith("tag:") && dimensions.includes(axis.slice("tag:".length))) {
      return axis as CostAxis;
    }
    return "epic";
  }, [axis, dimensions]);

  const slices = useMemo(
    () => costSlices(active, project, runs),
    [active, project, runs],
  );

  // Run-derived axes carry ids; resolve to human names for display.
  const labelOf = useMemo(() => {
    if (active === "workflow") {
      const names = new Map(workflows.map((w) => [w.id, w.name]));
      return (s: CostSlice) => names.get(s.key) ?? s.label;
    }
    if (active === "agent") {
      const names = new Map((roster?.agents ?? []).map((a) => [a.id, a.name]));
      return (s: CostSlice) => names.get(s.key) ?? s.label;
    }
    return (s: CostSlice) => s.label;
  }, [active, workflows, roster]);

  const total = useMemo(
    () =>
      slices.reduce(
        (acc, s) => ({
          costUsd: acc.costUsd + s.costUsd,
          tokens: acc.tokens + s.tokens,
          live: acc.live + s.liveCount,
        }),
        { costUsd: 0, tokens: 0, live: 0 },
      ),
    [slices],
  );
  const max = slices[0]?.costUsd ?? 0;

  const axes: { id: string; label: string }[] = [
    { id: "epic", label: "Epic" },
    { id: "human", label: "Owner" },
    { id: "workflow", label: "Workflow" },
    { id: "agent", label: "Agent" },
    ...dimensions.map((d) => ({ id: `tag:${d}`, label: `#${d}` })),
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto p-5">
      <div className="flex flex-wrap items-center gap-1">
        {axes.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onAxisChange(a.id)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              active === a.id
                ? "border-crystal-500/40 bg-crystal-500/15 text-crystal-200"
                : "border-edge text-ink-muted hover:border-edge-strong hover:text-ink",
            )}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* The headline: what this axis's slices add up to. Note the tag axes
          over-count on purpose (multi-tag tasks bill every value). */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Total cost" value={formatRunCost(total.costUsd)} />
        <Stat label="Tokens" value={formatRunTokens(total.tokens)} />
        <Stat label="Live runs" value={total.live ? String(total.live) : "—"} />
      </div>
      {active.startsWith("tag:") ? (
        <p className="-mt-1 text-[10px] text-ink-faint">
          Tag attribution is a lens, not a partition — a task tagged with two values bills both
          in full, so slices can sum past the real total.
        </p>
      ) : null}

      {slices.length === 0 ? (
        <EmptyState icon={Coins} title="Nothing billed yet">
          Dispatch agents from the board or workflows — every run's tokens and dollars land
          here, attributed by {active === "epic" ? "epic" : active === "human" ? "owner" : active}.
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {slices.map((s) => (
            <SliceRow key={s.key} slice={s} label={labelOf(s)} max={max} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-edge bg-surface-1 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

/** One slice: label + counts, right-aligned figures, a thin single-hue bar. */
function SliceRow({ slice, label, max }: { slice: CostSlice; label: string; max: number }) {
  const share = max > 0 ? Math.max(slice.costUsd / max, 0.01) : 0;
  const counts = [
    slice.taskCount ? `${slice.taskCount} task${slice.taskCount === 1 ? "" : "s"}` : null,
    slice.runCount ? `${slice.runCount} run${slice.runCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const modelSplit = slice.byModel
    .filter((m) => m.costUsd > 0)
    .map((m) => `${m.model} ${formatRunCost(m.costUsd)}`)
    .join(" · ");

  return (
    <div
      className="border-b border-edge/60 py-2 last:border-b-0"
      title={`${label}: ${formatRunCost(slice.costUsd)} · ${formatRunTokens(slice.tokens)} tokens${counts ? ` · ${counts}` : ""}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
          {label}
          {slice.liveCount > 0 ? (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-normal text-info">
              <StatusDot status="running" /> {slice.liveCount} live
            </span>
          ) : null}
        </span>
        {counts ? <span className="shrink-0 text-[10px] text-ink-faint">{counts}</span> : null}
        <span className="shrink-0 text-[10px] tabular-nums text-ink-muted">
          {formatRunTokens(slice.tokens)} tok
        </span>
        <span className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums text-ink">
          {formatRunCost(slice.costUsd)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-crystal-500"
          style={{ width: `${Math.round(share * 1000) / 10}%` }}
        />
      </div>
      {modelSplit ? (
        <div className="mt-0.5 truncate text-[10px] text-ink-faint">{modelSplit}</div>
      ) : null}
    </div>
  );
}
