import type { Bucket } from "./stats.js";
import { padCell } from "./util.js";

export function renderReport(buckets: Bucket[]): string {
  const header = `${padCell("key", 24)} ${padCell("count", 8)} ${padCell("err%", 8)} p95ms`;
  const rows = buckets.map(
    (b) =>
      `${padCell(b.key, 24)} ${padCell(String(b.count), 8)} ${padCell(
        (b.errorRate * 100).toFixed(1),
        8,
      )} ${b.p95LatencyMs}`,
  );
  return [header, "-".repeat(header.length), ...rows].join("\n");
}
