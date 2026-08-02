import { promptHeadline, usageTotalTokens, type AgentRun } from "./agent.js";
import { runCostUsd } from "./orchestration.js";

/**
 * Workspace recap — "where you left off", derived entirely from the run list
 * (no model call; operator-oss uses an LLM for this, but most of the value is
 * cheap arithmetic). Shown on the overview's workspace cards.
 */

export interface WorkspaceRecap {
  /** Newest run activity (end, else start) — null when nothing ever ran. */
  lastActivityAt: string | null;
  /** The newest run's first prompt line + its outcome, for one-line display. */
  headline: string | null;
  /** Rolling last-24h activity. */
  last24h: { runCount: number; costUsd: number; tokens: number; failed: number };
}

const HEADLINE_CHARS = 64;

export function buildWorkspaceRecap(runs: readonly AgentRun[], now = new Date()): WorkspaceRecap {
  let newest: AgentRun | null = null;
  let newestAt = "";
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const last24h = { runCount: 0, costUsd: 0, tokens: 0, failed: 0 };

  for (const run of runs) {
    const at = run.endedAt ?? run.startedAt ?? run.createdAt;
    if (at > newestAt) {
      newestAt = at;
      newest = run;
    }
    const created = Date.parse(run.createdAt);
    if (Number.isFinite(created) && created >= dayAgo) {
      last24h.runCount += 1;
      last24h.costUsd += runCostUsd(run);
      last24h.tokens += usageTotalTokens(run.usage);
      if (run.status === "failed") last24h.failed += 1;
    }
  }

  if (!newest) return { lastActivityAt: null, headline: null, last24h };
  const title = promptHeadline(newest.prompt, HEADLINE_CHARS);
  const outcome =
    newest.status === "running" || newest.status === "queued" ? "running" : newest.status;
  return {
    lastActivityAt: newestAt,
    headline: `${title || "(untitled run)"} — ${outcome}`,
    last24h,
  };
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" for a recap timestamp. */
export function formatRecapAge(iso: string, now = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  // Clock skew can put a run slightly in the future — clamp, don't vanish.
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
