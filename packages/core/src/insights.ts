import { usageTotalTokens, type AgentRun } from "./agent.js";
import { runCostUsd } from "./orchestration.js";

/**
 * Usage insights — the pure aggregation behind the orchestrator's Insights
 * tab. Everything derives client-side from the run list (runs already carry
 * usage, model and purpose), bucketed by *local* calendar day so the chart
 * matches the user's sense of "today". One fold produces the widest window;
 * the UI slices periods without refetching.
 */

/** Selectable insight windows in days — the single list the deep-link codec and UI share. */
export const INSIGHT_PERIODS = [7, 30, 90] as const;
export type InsightPeriod = (typeof INSIGHT_PERIODS)[number];

/** "$3.42" / "<$0.01" — the one dollar-format rule every surface shares. */
export function formatUsd(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return `$${costUsd >= 100 ? costUsd.toFixed(0) : costUsd.toFixed(2)}`;
}

export interface InsightSlice {
  costUsd: number;
  tokens: number;
  runCount: number;
}

export interface InsightDay extends InsightSlice {
  /** Local calendar day, "YYYY-MM-DD". */
  date: string;
  byModel: Record<string, InsightSlice>;
}

export interface UsageInsights {
  /** One entry per day, oldest first — continuous (zero-filled gaps). */
  days: InsightDay[];
  totals: InsightSlice & { activeMs: number };
  /** The same-length window immediately before, for trend comparison. */
  prior: InsightSlice;
  byModel: Record<string, InsightSlice>;
  byPurpose: Record<string, InsightSlice>;
}

/** Local calendar day of an ISO timestamp ("YYYY-MM-DD"). */
export function localDayKey(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const d = Number.isNaN(date.getTime()) ? now : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptySlice(): InsightSlice {
  return { costUsd: 0, tokens: 0, runCount: 0 };
}

function addTo(slice: InsightSlice, costUsd: number, tokens: number): void {
  slice.costUsd += costUsd;
  slice.tokens += tokens;
  slice.runCount += 1;
}

/**
 * Fold runs into per-day facts for the last `days` local calendar days
 * (today included) plus a prior-window comparison. Runs outside both windows
 * are ignored; queued/live runs count with their usage so far — the chart is
 * a spend meter, not an accounting ledger.
 */
export function buildUsageInsights(
  runs: readonly AgentRun[],
  opts: { days: number; now?: Date },
): UsageInsights {
  const now = opts.now ?? new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.floor(opts.days));

  // Window boundaries in *local* time: start of (today - days + 1).
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowStart = new Date(startOfToday.getTime() - (days - 1) * dayMs);
  const priorStart = new Date(windowStart.getTime() - days * dayMs);

  const byDay = new Map<string, InsightDay>();
  for (let i = 0; i < days; i++) {
    const key = localDayKey(new Date(windowStart.getTime() + i * dayMs).toISOString(), now);
    byDay.set(key, { date: key, ...emptySlice(), byModel: {} });
  }

  const totals = { ...emptySlice(), activeMs: 0 };
  const prior = emptySlice();
  const byModel: Record<string, InsightSlice> = {};
  const byPurpose: Record<string, InsightSlice> = {};

  for (const run of runs) {
    const created = new Date(run.createdAt);
    if (Number.isNaN(created.getTime()) || created.getTime() < priorStart.getTime()) continue;
    const cost = runCostUsd(run);
    const tokens = usageTotalTokens(run.usage);
    if (created.getTime() < windowStart.getTime()) {
      addTo(prior, cost, tokens);
      continue;
    }
    const day = byDay.get(localDayKey(run.createdAt, now));
    if (!day) continue; // createdAt in the future — clock skew, ignore
    addTo(day, cost, tokens);
    addTo(totals, cost, tokens);
    totals.activeMs += run.durationMs ?? 0;
    const model = run.model ?? "unknown";
    addTo((day.byModel[model] ??= emptySlice()), cost, tokens);
    addTo((byModel[model] ??= emptySlice()), cost, tokens);
    const purpose = run.purpose ?? "other";
    addTo((byPurpose[purpose] ??= emptySlice()), cost, tokens);
  }

  return { days: [...byDay.values()], totals, prior, byModel, byPurpose };
}
