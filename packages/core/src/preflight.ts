import { z } from "zod";

/**
 * Dispatch pre-flight — the *rules* half of the environment report attached
 * to a workflow before its first expensive run (probing lives in the server's
 * preflight.ts, which owns fs/PATH access).
 *
 * The failure this exists for: a manager gets dispatched into a workspace
 * whose environment can't actually run the work (no node on PATH, no pnpm),
 * and the gap is discovered mid-workflow by a worker burning a paid run on
 * "command not found". The pre-flight diffs what the repo's own marker files
 * imply the work needs against what the spawn environment can resolve, and
 * the result is a typed report: stored on the workflow record, rendered into
 * the manager's kickoff prompt and status text, and rolled up into the hub's
 * dispatch report — visible *before* the first worker, not after the sixth.
 */

/** One probed tool: what was looked for, why, and whether it resolved. */
export const EnvCheckSchema = z.object({
  id: z.string(),
  /** Display name ("pnpm", "Node.js"). */
  label: z.string(),
  /** Binary names probed, alternates in order — the first hit wins. */
  bins: z.array(z.string()),
  /** Why the tool is expected: the marker file that implied it, or "always". */
  reason: z.string(),
  ok: z.boolean(),
  /** Resolved absolute path when found. */
  resolved: z.string().nullish(),
});
export type EnvCheck = z.infer<typeof EnvCheckSchema>;

export const EnvReportSchema = z.object({
  checkedAt: z.string(),
  /** Every check resolved. */
  ok: z.boolean(),
  checks: z.array(EnvCheckSchema),
});
export type EnvReport = z.infer<typeof EnvReportSchema>;

/** A tool the workspace's marker files say the work will need. */
export interface EnvToolNeed {
  id: string;
  label: string;
  bins: string[];
  reason: string;
}

/**
 * The tools implied by a workspace root's directory listing. Marker-driven
 * and deliberately shallow: lockfiles name the package manager, manifests
 * name the runtime. `git` is always expected — every workflow commits.
 */
export function toolNeedsForMarkers(markers: readonly string[]): EnvToolNeed[] {
  const files = new Set(markers.map((m) => m.toLowerCase()));
  const needs: EnvToolNeed[] = [
    { id: "git", label: "git", bins: ["git"], reason: "always — workflows commit and merge" },
  ];
  if (files.has("package.json")) {
    needs.push({ id: "node", label: "Node.js", bins: ["node"], reason: "package.json" });
    if (files.has("pnpm-lock.yaml")) {
      needs.push({ id: "pnpm", label: "pnpm", bins: ["pnpm"], reason: "pnpm-lock.yaml" });
    } else if (files.has("yarn.lock")) {
      needs.push({ id: "yarn", label: "yarn", bins: ["yarn"], reason: "yarn.lock" });
    } else {
      needs.push({ id: "npm", label: "npm", bins: ["npm"], reason: "package.json" });
    }
  }
  if (files.has("cargo.toml")) {
    needs.push({ id: "cargo", label: "cargo", bins: ["cargo"], reason: "Cargo.toml" });
  }
  if (files.has("go.mod")) {
    needs.push({ id: "go", label: "go", bins: ["go"], reason: "go.mod" });
  }
  if (files.has("pyproject.toml") || files.has("requirements.txt")) {
    needs.push({
      id: "python",
      label: "Python",
      bins: ["python3", "python"],
      reason: files.has("pyproject.toml") ? "pyproject.toml" : "requirements.txt",
    });
  }
  if (files.has("gemfile")) {
    needs.push({ id: "ruby", label: "Ruby", bins: ["ruby"], reason: "Gemfile" });
  }
  return needs;
}

/** The checks that failed — the report's whole point, as a list. */
export function envGaps(report: Pick<EnvReport, "checks">): EnvCheck[] {
  return report.checks.filter((c) => !c.ok);
}

/** The report as an agent/UI reads it — one line per check, gaps loud. */
export function envReportText(report: EnvReport): string {
  const lines = [`Environment pre-flight (${report.ok ? "ok" : "GAPS"}):`];
  for (const c of report.checks) {
    lines.push(
      c.ok
        ? `- ${c.label}: ok (${c.resolved ?? c.bins[0]})`
        : `- ${c.label}: MISSING — expected because ${c.reason}; probed ${c.bins.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The kickoff-prompt injection, or null when the environment is clean. Tells
 * the manager the gap exists *and* what to do with it — raise a question
 * instead of proving the gap again one failed worker at a time.
 */
export function envGapPromptNote(report: EnvReport | null | undefined): string | null {
  if (!report) return null;
  const gaps = envGaps(report);
  if (!gaps.length) return null;
  return [
    "ENVIRONMENT GAPS (pre-flight): this workspace cannot resolve " +
      gaps.map((c) => `${c.label} (expected because ${c.reason})`).join(", ") +
      ".",
    "Any worker relying on these will fail. Do not discover this by dispatching — plan around " +
      "the gaps, and if the goal cannot be met without them, raise ask_question immediately " +
      "so the owner can fix the environment before money is spent.",
  ].join("\n");
}
