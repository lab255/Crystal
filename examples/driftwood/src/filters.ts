import type { LogLine } from "./parse.js";

export type LineFilter = (line: LogLine) => boolean;

export function statusFilter(status: number): LineFilter {
  return (line) => line.status === status;
}

export function routeFilter(pattern: RegExp): LineFilter {
  return (line) => pattern.test(line.route);
}

export function applyFilters(lines: (LogLine | null)[], filters: LineFilter[]): LogLine[] {
  const out: LogLine[] = [];
  for (const line of lines) {
    if (line && filters.every((f) => f(line))) out.push(line);
  }
  return out;
}
