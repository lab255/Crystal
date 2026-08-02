import { describe, expect, it } from "vitest";
import { buildUsageInsights, localDayKey } from "./insights.js";
import { createAgentRun, type AgentRun } from "./agent.js";

function run(init: {
  createdAt: string;
  costUsd?: number;
  tokens?: number;
  model?: string;
  purpose?: AgentRun["purpose"];
}): AgentRun {
  const r = createAgentRun({ prompt: "x", purpose: init.purpose ?? null });
  r.createdAt = init.createdAt;
  r.costUsd = init.costUsd ?? 0;
  r.model = init.model ?? "claude-sonnet";
  if (init.tokens) {
    r.usage = {
      inputTokens: init.tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      apiCalls: 1,
    };
  }
  return r;
}

/** Local-noon ISO for N days ago — immune to DST-edge day shifts. */
function daysAgo(n: number, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12, 0, 0);
  return d.toISOString();
}

describe("buildUsageInsights", () => {
  const now = new Date(2026, 6, 15, 15, 30); // July 15, local

  it("zero-fills a continuous day range, oldest first", () => {
    const insights = buildUsageInsights([], { days: 7, now });
    expect(insights.days).toHaveLength(7);
    expect(insights.days[6]!.date).toBe(localDayKey(now.toISOString(), now));
    expect(insights.days.every((d) => d.costUsd === 0)).toBe(true);
  });

  it("buckets runs into local days and totals cost/tokens", () => {
    const runs = [
      run({ createdAt: daysAgo(0, now), costUsd: 1.5, tokens: 1000 }),
      run({ createdAt: daysAgo(0, now), costUsd: 0.5, tokens: 500 }),
      run({ createdAt: daysAgo(2, now), costUsd: 2, tokens: 2000, model: "claude-opus" }),
    ];
    const insights = buildUsageInsights(runs, { days: 7, now });
    const today = insights.days[6]!;
    expect(today.costUsd).toBeCloseTo(2);
    expect(today.runCount).toBe(2);
    expect(insights.totals.costUsd).toBeCloseTo(4);
    expect(insights.totals.tokens).toBe(3500);
    expect(insights.days[4]!.byModel["claude-opus"]!.costUsd).toBeCloseTo(2);
  });

  it("attributes the prior window separately and drops older runs", () => {
    const runs = [
      run({ createdAt: daysAgo(1, now), costUsd: 1 }),
      run({ createdAt: daysAgo(8, now), costUsd: 5 }), // prior window (7d)
      run({ createdAt: daysAgo(20, now), costUsd: 100 }), // beyond both
    ];
    const insights = buildUsageInsights(runs, { days: 7, now });
    expect(insights.totals.costUsd).toBeCloseTo(1);
    expect(insights.prior.costUsd).toBeCloseTo(5);
  });

  it("splits by model and purpose", () => {
    const runs = [
      run({ createdAt: daysAgo(0, now), costUsd: 1, purpose: "implement" }),
      run({ createdAt: daysAgo(0, now), costUsd: 2, purpose: "code-review", model: "claude-haiku" }),
    ];
    const insights = buildUsageInsights(runs, { days: 7, now });
    expect(insights.byPurpose["implement"]!.costUsd).toBeCloseTo(1);
    expect(insights.byPurpose["code-review"]!.costUsd).toBeCloseTo(2);
    expect(insights.byModel["claude-haiku"]!.runCount).toBe(1);
  });

  it("estimates cost from usage when the CLI reported none", () => {
    const r = run({ createdAt: daysAgo(0, now), tokens: 1_000_000 });
    r.costUsd = null;
    const insights = buildUsageInsights([r], { days: 7, now });
    expect(insights.totals.costUsd).toBeGreaterThan(0); // priced via MODEL_PRICING
  });
});
