import { z } from "zod";
import { nowIso, uid } from "./ids.js";
import { isAgentTag, usageTotalTokens, type AgentRun, type AgentUsage } from "./agent.js";
import { tagsInDimension } from "./tags.js";
import {
  CostRollupSchema,
  TaskPrioritySchema,
  TaskSizeSchema,
  TaskStatusSchema,
  type CostRollup,
  type Project,
  type TaskItem,
  type TaskLease,
} from "./project.js";

/**
 * Orchestration logic — the pure half of Crystal's multi-agent layer.
 *
 * Three concerns, all board-centric (the board is the single source of truth;
 * agents share no memory besides it):
 *
 *  - **Leases / borrow checking.** One writer per task. An agent claims a task
 *    and receives a capability token (`claimId`); every mutation must present
 *    it. Leases carry a TTL so a crashed holder heals automatically — the next
 *    claimant steals a stale lease instead of the board deadlocking.
 *  - **Cost attribution.** Run usage is metered per assistant turn (see
 *    agent.ts); this module prices it per model and folds it into durable
 *    {@link CostRollup}s written onto tasks and epics.
 *  - Everything here is pure and clock-injected, so the rules are
 *    unit-testable; enforcement lives in the server's OrchestrationService.
 */

/* ------------------------------------------------------------------ */
/* Leases — the borrow checker                                         */
/* ------------------------------------------------------------------ */

/** Default lease TTL. Holders heartbeat (re-claim) to extend. */
export const LEASE_DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Longest TTL a claimant may request. */
export const LEASE_MAX_TTL_MS = 4 * 60 * 60 * 1000;

export function leaseValid(lease: TaskLease | null | undefined, now = Date.now()): boolean {
  return !!lease && Date.parse(lease.expiresAt) > now;
}

export type ClaimResult =
  | { ok: true; lease: TaskLease; /** True when a stale lease was healed. */ stolen: boolean }
  | { ok: false; reason: string; /** The valid lease standing in the way. */ heldBy: TaskLease };

/**
 * Try to claim a task. Succeeds when the task is unleased, the lease is stale
 * (healed — `stolen: true`), or the claimant already holds it (heartbeat:
 * same `claimId` extends the TTL, keeping the token stable).
 */
export function claimLease(
  current: TaskLease | null | undefined,
  init: { holder: string; holderRunId?: string | null; claimId?: string; ttlMs?: number },
  now = Date.now(),
): ClaimResult {
  const ttl = Math.min(Math.max(init.ttlMs ?? LEASE_DEFAULT_TTL_MS, 1000), LEASE_MAX_TTL_MS);
  if (leaseValid(current, now) && current!.claimId !== init.claimId) {
    return {
      ok: false,
      reason: `Task is leased to ${current!.holder} until ${current!.expiresAt}`,
      heldBy: current!,
    };
  }
  const heartbeat = leaseValid(current, now) && current!.claimId === init.claimId;
  return {
    ok: true,
    stolen: !heartbeat && current != null,
    lease: {
      claimId: heartbeat ? current!.claimId : (init.claimId ?? uid("claim")),
      holder: init.holder,
      holderRunId: init.holderRunId ?? null,
      acquiredAt: heartbeat ? current!.acquiredAt : nowIso(),
      expiresAt: new Date(now + ttl).toISOString(),
    },
  };
}

/**
 * Hand a lease from the run that claimed it to the run doing the work (a
 * manager dispatching a worker against its claimed task). The claimId is
 * unchanged — the capability moves with the lease — but `holderRunId` now
 * names the worker, so the lease is released when the *work* settles, not
 * when the coordinator's turn ends. Extends the TTL so a short manager lease
 * doesn't expire under a long-running worker. Returns null when the lease
 * isn't the dispatcher's to hand over.
 */
export function transferLease(
  lease: TaskLease | null | undefined,
  fromRunId: string,
  to: { runId: string; holder?: string },
  now = Date.now(),
): TaskLease | null {
  if (!leaseValid(lease, now) || lease!.holderRunId !== fromRunId) return null;
  return {
    ...lease!,
    holder: to.holder ?? lease!.holder,
    holderRunId: to.runId,
    expiresAt: new Date(
      Math.max(Date.parse(lease!.expiresAt), now + LEASE_DEFAULT_TTL_MS),
    ).toISOString(),
  };
}

export type WriteCheck = { ok: true } | { ok: false; reason: string };

/**
 * The borrow check for one mutation. `force` is the human-owner override —
 * the board belongs to the user; agents never pass it.
 */
export function checkWrite(
  lease: TaskLease | null | undefined,
  claimId: string | null | undefined,
  opts: { force?: boolean } = {},
  now = Date.now(),
): WriteCheck {
  if (opts.force) return { ok: true };
  if (!leaseValid(lease, now)) {
    return { ok: false, reason: "Task is not claimed — claim it before writing (one writer per task)." };
  }
  if (lease!.claimId !== claimId) {
    return {
      ok: false,
      reason: `Task is leased to ${lease!.holder} until ${lease!.expiresAt} — you do not hold the claim.`,
    };
  }
  return { ok: true };
}

/**
 * The mutable surface of one lease-checked task write. Everything else on a
 * task (lease, cost, runIds, questions) is server-owned or has its own flow.
 */
export const TaskPatchSchema = z
  .object({
    title: z.string().min(1),
    description: z.string(),
    status: TaskStatusSchema,
    priority: TaskPrioritySchema,
    size: TaskSizeSchema.nullable(),
    epicId: z.string().nullable(),
    blockedBy: z.array(z.string()),
    labels: z.array(z.string()),
    order: z.number(),
  })
  .partial();
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/* ------------------------------------------------------------------ */
/* Cost attribution                                                    */
/* ------------------------------------------------------------------ */

/** $ per million tokens, by usage class. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Cache reads bill at a fraction of input (typically ×0.1). */
  cacheRead: number;
  /** Cache writes bill above input (typically ×1.25 for the 5m tier). */
  cacheWrite: number;
}

/**
 * Prices per Mtok, matched by substring on the model id (first hit wins, so
 * keep more specific entries first). Unknown models fall back to Sonnet-class
 * pricing — a visible-but-wrong dollar figure beats a silent zero.
 */
export const MODEL_PRICING: readonly { match: string; pricing: ModelPricing }[] = [
  { match: "fable", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { match: "mythos", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { match: "opus", pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: "haiku", pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: "sonnet", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
];

const FALLBACK_PRICING: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export function pricingForModel(model: string | null | undefined): ModelPricing {
  const id = (model ?? "").toLowerCase();
  return MODEL_PRICING.find((m) => id.includes(m.match))?.pricing ?? FALLBACK_PRICING;
}

/**
 * One run's dollars — the single cost-precedence rule: the CLI-reported
 * `costUsd` wins when present (it knows the real bill), usage-based
 * estimation covers the rest. Every spend rollup (task, epic, workflow)
 * folds over this so the rule can never drift between them.
 */
export function runCostUsd(run: Pick<AgentRun, "costUsd" | "model" | "usage">): number {
  return run.costUsd ?? (run.usage ? estimateCostUsd(run.model, run.usage) : 0);
}

/** Estimated $ for one run's usage at its model's prices. */
export function estimateCostUsd(model: string | null | undefined, usage: AgentUsage): number {
  const p = pricingForModel(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheCreationTokens * p.cacheWrite) /
    1_000_000
  );
}

/**
 * Fold settled runs into a durable rollup. The CLI-reported `costUsd` wins
 * when present (it knows the real bill); usage-based estimation covers the
 * rest. Tokens count everything including cache reads — that is where real
 * money goes, and hiding them makes costs read ~10× too low.
 */
export function rollupCost(runs: readonly AgentRun[], at = nowIso()): CostRollup {
  const byModel = new Map<string, { totalTokens: number; costUsd: number }>();
  let totalTokens = 0;
  let costUsd = 0;
  let runCount = 0;
  for (const run of runs) {
    const usage = run.usage;
    const tokens = usageTotalTokens(usage);
    const dollars = runCostUsd(run);
    if (tokens === 0 && dollars === 0) continue;
    runCount += 1;
    totalTokens += tokens;
    costUsd += dollars;
    const model = run.model ?? "unknown";
    const entry = byModel.get(model) ?? { totalTokens: 0, costUsd: 0 };
    entry.totalTokens += tokens;
    entry.costUsd += dollars;
    byModel.set(model, entry);
  }
  return CostRollupSchema.parse({
    totalTokens,
    costUsd,
    runCount,
    byModel: Object.fromEntries(byModel),
    updatedAt: at,
  });
}

/** Sum rollups (epic cost = its tasks' costs). Null when nothing to sum. */
export function sumCostRollups(
  rollups: readonly (CostRollup | null | undefined)[],
  at = nowIso(),
): CostRollup | null {
  const present = rollups.filter((r): r is CostRollup => r != null);
  if (present.length === 0) return null;
  const byModel = new Map<string, { totalTokens: number; costUsd: number }>();
  let totalTokens = 0;
  let costUsd = 0;
  let runCount = 0;
  for (const r of present) {
    totalTokens += r.totalTokens;
    costUsd += r.costUsd;
    runCount += r.runCount;
    for (const [model, m] of Object.entries(r.byModel)) {
      const entry = byModel.get(model) ?? { totalTokens: 0, costUsd: 0 };
      entry.totalTokens += m.totalTokens;
      entry.costUsd += m.costUsd;
      byModel.set(model, entry);
    }
  }
  return CostRollupSchema.parse({
    totalTokens,
    costUsd,
    runCount,
    byModel: Object.fromEntries(byModel),
    updatedAt: at,
  });
}

/** "412k tok · $3.42" — the board-column rendering of a rollup. */
export function formatCost(cost: CostRollup | null | undefined): string {
  if (!cost) return "";
  const k = Math.round(cost.totalTokens / 1000);
  const usd = cost.costUsd >= 100 ? cost.costUsd.toFixed(0) : cost.costUsd.toFixed(2);
  return `${k}k tok · $${usd}`;
}

/**
 * A task's cost for display: the durable rollup (settled runs, survives run
 * history aging out) plus any still-active runs' live usage. Falls back to
 * summing every attributed run when no rollup was written yet. Never mixes
 * settled runs from app data into a rollup that already includes them.
 */
export function taskLiveUsage(
  task: TaskItem,
  runs: readonly AgentRun[],
): { tokens: number; costUsd: number } | null {
  const mine = runs.filter((r) => r.taskId === task.id);
  const active = mine.filter((r) => r.status === "running" || r.status === "queued");
  const base = task.cost
    ? { tokens: task.cost.totalTokens, costUsd: task.cost.costUsd }
    : mine
        .filter((r) => r.status !== "running" && r.status !== "queued")
        .reduce(
          (acc, r) => ({
            tokens: acc.tokens + usageTotalTokens(r.usage),
            costUsd: acc.costUsd + runCostUsd(r),
          }),
          { tokens: 0, costUsd: 0 },
        );
  const total = active.reduce(
    (acc, r) => ({
      tokens: acc.tokens + usageTotalTokens(r.usage),
      costUsd: acc.costUsd + runCostUsd(r),
    }),
    base,
  );
  if (total.tokens === 0 && total.costUsd === 0 && !task.cost && mine.length === 0) return null;
  return total;
}

/* ------------------------------------------------------------------ */
/* Cost attribution by axis                                            */
/* ------------------------------------------------------------------ */

/** One row of a cost-attribution view: everything billed to one value of the axis. */
export interface CostSlice {
  /** Stable identity within the axis (epic id, owner name, tag value, workflow id…). */
  key: string;
  label: string;
  costUsd: number;
  tokens: number;
  /** Board tasks contributing (task-derived axes; 0 for run-derived axes). */
  taskCount: number;
  /** Runs contributing (run-derived axes; 0 for task-derived axes). */
  runCount: number;
  /** Live (running/queued) runs currently adding to this slice. */
  liveCount: number;
  /** Cost split by model, largest first (durable rollups + live runs). */
  byModel: { model: string; costUsd: number }[];
}

/**
 * Attribution axes. Task-derived axes (`epic`, `human`, `tag:<dimension>`)
 * fold each task's bill — durable rollup plus live top-up, via
 * {@link taskLiveUsage} — under the task's value of the axis; runs that never
 * touched a board task land in a trailing "No task" slice so the view's total
 * still reconciles with real spend. Run-derived axes (`workflow`, `agent`)
 * group the run list by attribution tag.
 *
 * `tag:` is deliberately multi-dimensional: a task tagged `ui` and `db`
 * contributes its full bill to both slices — attribution along a dimension is
 * a lens, not a partition, and halving the dollars would misstate what each
 * area actually cost.
 */
export type CostAxis = "epic" | "human" | "workflow" | "agent" | `tag:${string}`;

const NO_TASK_KEY = "__no_task__";
const NO_VALUE_KEY = "__none__";
/** Residue slices ("No task", "No epic", "Unassigned", "No <dim> tag"…). */
const RESIDUE_KEYS = new Set([NO_TASK_KEY, NO_VALUE_KEY]);

/** Live = still accruing; both states bill via {@link taskLiveUsage}. */
function isLive(run: Pick<AgentRun, "status">): boolean {
  return run.status === "running" || run.status === "queued";
}

/** A task's model split: the durable rollup's byModel plus live runs' estimates. */
function taskModelSplit(task: TaskItem, runs: readonly AgentRun[]): Map<string, number> {
  const split = new Map<string, number>();
  for (const [model, m] of Object.entries(task.cost?.byModel ?? {})) {
    split.set(model, (split.get(model) ?? 0) + m.costUsd);
  }
  for (const r of runs) {
    if (r.taskId !== task.id) continue;
    // With a rollup, settled runs are already inside it — only live runs top
    // up. Without one, every attributed run counts (taskLiveUsage's rule).
    if (task.cost && !isLive(r)) continue;
    const model = r.model ?? "unknown";
    split.set(model, (split.get(model) ?? 0) + runCostUsd(r));
  }
  return split;
}

function finishSlices(slices: CostSlice[]): CostSlice[] {
  const kept = slices.filter((s) => s.costUsd > 0 || s.tokens > 0 || s.liveCount > 0);
  for (const s of kept) s.byModel.sort((a, b) => b.costUsd - a.costUsd);
  // Residues ("No task", "No epic", "Unassigned", untagged) trail their
  // peers at equal cost, so a residue never outranks a real slice it ties
  // with.
  return kept.sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      Number(RESIDUE_KEYS.has(a.key)) - Number(RESIDUE_KEYS.has(b.key)),
  );
}

/** Fold one task set (grouped) plus non-task runs into slices. */
function taskAxisSlices(
  groupOf: (task: TaskItem) => { key: string; label: string }[],
  project: Project,
  runs: readonly AgentRun[],
): CostSlice[] {
  const slices = new Map<string, CostSlice>();
  const slice = (key: string, label: string): CostSlice => {
    let s = slices.get(key);
    if (!s) {
      s = { key, label, costUsd: 0, tokens: 0, taskCount: 0, runCount: 0, liveCount: 0, byModel: [] };
      slices.set(key, s);
    }
    return s;
  };
  const modelTotals = new Map<string, Map<string, number>>();
  for (const task of project.tasks) {
    const usage = taskLiveUsage(task, runs);
    if (!usage) continue;
    const live = runs.filter((r) => r.taskId === task.id && isLive(r)).length;
    const split = taskModelSplit(task, runs);
    for (const g of groupOf(task)) {
      const s = slice(g.key, g.label);
      s.costUsd += usage.costUsd;
      s.tokens += usage.tokens;
      s.taskCount += 1;
      s.liveCount += live;
      const totals = modelTotals.get(g.key) ?? new Map<string, number>();
      for (const [model, usd] of split) totals.set(model, (totals.get(model) ?? 0) + usd);
      modelTotals.set(g.key, totals);
    }
  }
  // Money spent outside any board task — the view's total must reconcile
  // with real spend, not silently hide it. Two shapes: runs that never had a
  // task (managers, jobs, consoles), and runs whose task was deleted after
  // billing (taskId no longer on the board; scoped by projectId so another
  // board's task-runs don't leak in).
  const taskIds = new Set(project.tasks.map((t) => t.id));
  const orphanTotals = new Map<string, number>();
  for (const r of runs) {
    const orphaned =
      r.taskId == null || (!taskIds.has(r.taskId) && r.projectId === project.id);
    if (!orphaned) continue;
    const usd = runCostUsd(r);
    const tokens = usageTotalTokens(r.usage);
    if (usd === 0 && tokens === 0 && !isLive(r)) continue;
    const s = slice(NO_TASK_KEY, "No task (managers, jobs, consoles)");
    s.costUsd += usd;
    s.tokens += tokens;
    s.runCount += 1;
    if (isLive(r)) s.liveCount += 1;
    const model = r.model ?? "unknown";
    orphanTotals.set(model, (orphanTotals.get(model) ?? 0) + usd);
  }
  for (const [key, s] of slices) {
    const totals = key === NO_TASK_KEY ? orphanTotals : modelTotals.get(key);
    s.byModel = [...(totals ?? new Map())].map(([model, costUsd]) => ({ model, costUsd }));
  }
  return finishSlices([...slices.values()]);
}

/** Group the run list by an attribution-tag value (workflow / agent axes). */
function runAxisSlices(
  runs: readonly AgentRun[],
  valueOf: (run: AgentRun) => string | null,
  untaggedLabel: string,
): CostSlice[] {
  const slices = new Map<string, CostSlice>();
  const modelTotals = new Map<string, Map<string, number>>();
  for (const r of runs) {
    const usd = runCostUsd(r);
    const tokens = usageTotalTokens(r.usage);
    if (usd === 0 && tokens === 0 && !isLive(r)) continue;
    const value = valueOf(r);
    const key = value ?? NO_TASK_KEY;
    let s = slices.get(key);
    if (!s) {
      s = {
        key,
        label: value ?? untaggedLabel,
        costUsd: 0,
        tokens: 0,
        taskCount: 0,
        runCount: 0,
        liveCount: 0,
        byModel: [],
      };
      slices.set(key, s);
    }
    s.costUsd += usd;
    s.tokens += tokens;
    s.runCount += 1;
    if (isLive(r)) s.liveCount += 1;
    const model = r.model ?? "unknown";
    const totals = modelTotals.get(key) ?? new Map<string, number>();
    totals.set(model, (totals.get(model) ?? 0) + usd);
    modelTotals.set(key, totals);
  }
  for (const [key, s] of slices) {
    s.byModel = [...(modelTotals.get(key) ?? new Map())].map(([model, costUsd]) => ({
      model,
      costUsd,
    }));
  }
  return finishSlices([...slices.values()]);
}

/**
 * THE cost-attribution fold: the project's spend sliced along one axis.
 * Pure — the UI hands it the board and the run list and renders rows.
 */
export function costSlices(
  axis: CostAxis,
  project: Project | null,
  runs: readonly AgentRun[],
): CostSlice[] {
  if (axis === "workflow") {
    return runAxisSlices(
      runs,
      (r) => r.tags.find((t) => t.startsWith("workflow:"))?.slice("workflow:".length) ?? null,
      "No workflow",
    );
  }
  if (axis === "agent") {
    return runAxisSlices(
      runs,
      (r) => {
        const tag = r.tags.find(isAgentTag);
        return tag ? tag.slice("agent:".length) : null;
      },
      "No profile",
    );
  }
  if (!project) return [];
  if (axis === "epic") {
    const epicName = new Map(project.epics.map((e) => [e.id, e.name]));
    return taskAxisSlices(
      (task) =>
        task.epicId && epicName.has(task.epicId)
          ? [{ key: task.epicId, label: epicName.get(task.epicId)! }]
          : [{ key: NO_VALUE_KEY, label: "No epic" }],
      project,
      runs,
    );
  }
  if (axis === "human") {
    return taskAxisSlices(
      (task) => {
        const owner = task.owners.human?.trim();
        return [owner ? { key: owner, label: owner } : { key: NO_VALUE_KEY, label: "Unassigned" }];
      },
      project,
      runs,
    );
  }
  const dimension = axis.slice("tag:".length);
  return taskAxisSlices(
    (task) => {
      const values = tagsInDimension(task.labels, dimension);
      return values.length
        ? values.map((v) => ({ key: v, label: v }))
        : [{ key: NO_VALUE_KEY, label: `No ${dimension} tag` }];
    },
    project,
    runs,
  );
}

/* ------------------------------------------------------------------ */
/* Whole-project save merge                                            */
/* ------------------------------------------------------------------ */

/**
 * Reconcile a client's whole-project save against what is on disk.
 *
 * Fresh saves (`incoming.rev === onDisk.rev`) apply wholesale — the client
 * edited exactly what the server holds. A stale rev means the board changed
 * under the client (an agent wrote through the lease path), so the save is
 * merged instead of replacing:
 *
 *  - tasks present on both sides: newer `updatedAt` wins the row;
 *  - tasks only on disk are kept (agent-created after the snapshot — a stale
 *    client must not delete them; a genuine user deletion lands on the next
 *    fresh-rev save);
 *  - tasks only in the incoming save are added (user-created);
 *  - epics merge the same way (no updatedAt — incoming wins the row).
 *
 * Server-owned columns (lease, cost) always come from disk regardless of
 * which side wins a row; `rev` is never taken from the client.
 */
export function mergeProjectSave(onDisk: Project, incoming: Project): Project {
  const serverColumns = (task: TaskItem, disk: TaskItem | undefined): TaskItem => ({
    ...task,
    lease: disk?.lease ?? null,
    cost: disk?.cost ?? null,
  });
  const diskTasks = new Map(onDisk.tasks.map((t) => [t.id, t]));
  const stale = incoming.rev !== onDisk.rev;

  let tasks: TaskItem[];
  let epics: Project["epics"];
  if (!stale) {
    tasks = incoming.tasks.map((t) => serverColumns(t, diskTasks.get(t.id)));
    const diskEpics = new Map(onDisk.epics.map((e) => [e.id, e]));
    epics = incoming.epics.map((e) => ({ ...e, cost: diskEpics.get(e.id)?.cost ?? null }));
  } else {
    const incomingTasks = new Map(incoming.tasks.map((t) => [t.id, t]));
    tasks = onDisk.tasks.map((disk) => {
      const client = incomingTasks.get(disk.id);
      const winner = client && client.updatedAt > disk.updatedAt ? client : disk;
      return serverColumns(winner, disk);
    });
    for (const t of incoming.tasks) {
      if (!diskTasks.has(t.id)) tasks.push(serverColumns(t, undefined));
    }
    const incomingEpics = new Map(incoming.epics.map((e) => [e.id, e]));
    epics = onDisk.epics.map((disk) => ({
      ...(incomingEpics.get(disk.id) ?? disk),
      cost: disk.cost ?? null,
    }));
    for (const e of incoming.epics) {
      if (!epics.some((x) => x.id === e.id)) epics.push({ ...e, cost: null });
    }
  }

  return {
    ...onDisk,
    name: incoming.name,
    description: incoming.description,
    wipLimits: incoming.wipLimits,
    epics,
    tasks,
  };
}
