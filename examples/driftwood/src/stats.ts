import type { LogLine } from "./parse.js";

export interface Bucket {
  key: string;
  count: number;
  errorRate: number;
  p95LatencyMs: number;
}

/** kth percentile of a sorted-or-not sample (nearest-rank). */
export function percentile(values: number[], k: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((k / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export function aggregate(lines: LogLine[], by: "route" | "status"): Bucket[] {
  const groups = new Map<string, LogLine[]>();
  for (const line of lines) {
    const key = by === "route" ? line.route : String(line.status);
    const list = groups.get(key) ?? [];
    list.push(line);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      errorRate: rows.filter((r) => r.status >= 500).length / rows.length,
      p95LatencyMs: percentile(rows.map((r) => r.latencyMs), 95),
    }))
    .sort((a, b) => b.count - a.count);
}
