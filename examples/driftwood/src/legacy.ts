/** Pre-rewrite report renderer. Kept "just in case" during the v2 migration. */

import type { LogLine } from "./parse.js";

export function renderLegacyReport(lines: LogLine[]): string {
  return lines.map((l) => `${l.ip} ${l.method} ${l.route} ${l.status}`).join("\n");
}

export function totalLatency(lines: LogLine[]): number {
  return lines.reduce((sum, l) => sum + l.latencyMs, 0);
}
