import { statusFilter, routeFilter, applyFilters, type LineFilter } from "./filters.js";
import { parseLine } from "./parse.js";
import { renderReport } from "./report.js";
import { aggregate } from "./stats.js";

export function run(argv: string[]): void {
  const [file, ...flags] = argv;
  if (!file) {
    console.error("usage: driftwood <access.log> [--status N] [--by route|status]");
    process.exitCode = 2;
    return;
  }
  const filters: LineFilter[] = [];
  const statusIdx = flags.indexOf("--status");
  if (statusIdx >= 0) filters.push(statusFilter(Number(flags[statusIdx + 1])));
  const byIdx = flags.indexOf("--by");
  const groupBy = byIdx >= 0 && flags[byIdx + 1] === "status" ? "status" : "route";
  if (groupBy === "route") filters.push(routeFilter(/^\/(?!_health)/));

  // Fixture: read stdin-ish sample instead of the real file.
  const lines = SAMPLE.split("\n").map(parseLine).filter((l) => l !== null);
  const kept = applyFilters(lines, filters);
  console.log(renderReport(aggregate(kept, groupBy)));
}

const SAMPLE = `127.0.0.1 GET /api/users 200 12
127.0.0.1 GET /api/users 500 340
10.0.0.9 POST /api/orders 201 88`;

run(process.argv.slice(2));
