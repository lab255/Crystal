import { describe, expect, it } from "vitest";
import { buildWorkspaceRecap, formatRecapAge } from "./recap.js";
import { createAgentRun, type AgentRun } from "./agent.js";

function run(init: {
  prompt: string;
  createdAt: string;
  endedAt?: string;
  status?: AgentRun["status"];
  costUsd?: number;
}): AgentRun {
  const r = createAgentRun({ prompt: init.prompt });
  r.createdAt = init.createdAt;
  r.endedAt = init.endedAt ?? null;
  r.status = init.status ?? "completed";
  r.costUsd = init.costUsd ?? 0;
  return r;
}

const NOW = new Date("2026-08-02T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

describe("buildWorkspaceRecap", () => {
  it("is empty for a workspace with no runs", () => {
    const recap = buildWorkspaceRecap([], NOW);
    expect(recap.lastActivityAt).toBeNull();
    expect(recap.headline).toBeNull();
    expect(recap.last24h.runCount).toBe(0);
  });

  it("headlines the newest run with its outcome and sums the last 24h", () => {
    const runs = [
      run({ prompt: "Old work", createdAt: iso(30), endedAt: iso(29), costUsd: 9 }),
      run({ prompt: "Fix the chart\nmore detail", createdAt: iso(2), endedAt: iso(1), costUsd: 1.5 }),
      run({ prompt: "Broken thing", createdAt: iso(3), endedAt: iso(3), status: "failed", costUsd: 0.5 }),
    ];
    const recap = buildWorkspaceRecap(runs, NOW);
    expect(recap.headline).toBe("Fix the chart — completed");
    expect(recap.lastActivityAt).toBe(iso(1));
    expect(recap.last24h.runCount).toBe(2); // 30h-old run excluded
    expect(recap.last24h.costUsd).toBeCloseTo(2);
    expect(recap.last24h.failed).toBe(1);
  });

  it("marks live runs as running and truncates long prompts", () => {
    const r = run({ prompt: "x".repeat(100), createdAt: iso(0.5), status: "running" });
    const recap = buildWorkspaceRecap([r], NOW);
    expect(recap.headline).toContain("running");
    expect(recap.headline!.length).toBeLessThan(90);
  });
});

describe("formatRecapAge", () => {
  it("scales units", () => {
    expect(formatRecapAge(iso(0), NOW)).toBe("just now");
    expect(formatRecapAge(iso(0.5), NOW)).toBe("30m ago");
    expect(formatRecapAge(iso(5), NOW)).toBe("5h ago");
    expect(formatRecapAge(iso(50), NOW)).toBe("2d ago");
  });
});
