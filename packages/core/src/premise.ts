import { z } from "zod";

/**
 * Premise check — the *rules* half of brief-assertion validation (probing
 * lives in the server's preflight.ts, which owns fs/git/PATH access).
 *
 * The failure this exists for: a brief carries verifiable claims ("PRs
 * #204/#205 are green and awaiting merge", "branch release/2.3 exists") that
 * are simply false by the time the work is dispatched — and the orchestrator
 * discovers it mid-workflow, several paid runs deep. A brief may carry
 * machine-checkable `assert:` lines; they are parsed here, probed against the
 * real repo at dispatch, and the typed report lands on the workflow record,
 * in the manager's kickoff prompt and status text, and on the hub's dispatch
 * report — a failed premise is a $0 fact before the first worker, not a paid
 * discovery after the sixth.
 *
 * Grammar (one assertion per line, anywhere in the brief/goal text):
 *
 *   assert: branch <name>     — the git branch exists (local or remote)
 *   assert: ref <rev>         — the rev resolves (`git rev-parse`): a SHA, tag…
 *   assert: file <path>       — the path exists under the workspace root
 *   assert: tool <bin>        — the binary resolves on the agents' spawn PATH
 *   assert: cmd <command>     — the command exits 0 in the workspace root
 */

export const PREMISE_ASSERT_KINDS = ["branch", "ref", "file", "tool", "cmd"] as const;
export const PremiseAssertKindSchema = z.enum(PREMISE_ASSERT_KINDS);
export type PremiseAssertKind = z.infer<typeof PremiseAssertKindSchema>;

/** One parsed (not yet probed) assertion from a brief. */
export interface PremiseAssert {
  kind: PremiseAssertKind;
  /** The assertion's argument: branch name, rev, path, binary, or command. */
  arg: string;
  /** The verbatim brief line, for reporting discrepancies in the author's words. */
  raw: string;
}

/** An `assert:` marker whose kind or required argument could not be parsed. */
export interface MalformedPremiseAssert {
  kind: "malformed";
  arg: string;
  raw: string;
  reason: "missing-kind" | "unknown-kind" | "missing-argument";
}

/** One probed assertion: what was claimed, and whether the repo agrees. */
export const PremiseCheckSchema = z.object({
  kind: z.union([PremiseAssertKindSchema, z.literal("malformed")]),
  arg: z.string(),
  raw: z.string(),
  ok: z.boolean(),
  /** Why it failed (probe output), or what it resolved to. */
  detail: z.string().nullish(),
});
export type PremiseCheck = z.infer<typeof PremiseCheckSchema>;

export const PremiseReportSchema = z.object({
  checkedAt: z.string(),
  /** Every assertion held. */
  ok: z.boolean(),
  checks: z.array(PremiseCheckSchema),
});
export type PremiseReport = z.infer<typeof PremiseReportSchema>;

const ASSERT_LINE = /^assert:\s*(.*)$/i;

/**
 * Every `assert:` line in a brief/goal, parsed. Unknown or incomplete claims
 * come back as `malformed` so the probe can fail them loudly; a claim the
 * checker silently skipped would otherwise read as one that held.
 */
export function parseAsserts(text: string): (PremiseAssert | MalformedPremiseAssert)[] {
  const out: (PremiseAssert | MalformedPremiseAssert)[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = ASSERT_LINE.exec(line);
    if (!m) continue;
    const body = (m[1] ?? "").trim();
    if (!body) {
      out.push({ kind: "malformed", arg: "", raw: line, reason: "missing-kind" });
      continue;
    }
    const [kindToken, ...argParts] = body.split(/\s+/);
    const kindRaw = kindToken!.toLowerCase();
    const arg = argParts.join(" ");
    const parsed = PremiseAssertKindSchema.safeParse(kindRaw);
    if (!parsed.success) {
      out.push({ kind: "malformed", arg: body, raw: line, reason: "unknown-kind" });
    } else if (arg) {
      out.push({ kind: parsed.data, arg, raw: line });
    } else {
      // A kind with no argument is a malformed claim, not a held one.
      out.push({ kind: "malformed", arg: kindRaw, raw: line, reason: "missing-argument" });
    }
  }
  return out;
}

/** True when the text carries at least one `assert:` line worth probing. */
export function hasAsserts(text: string): boolean {
  return parseAsserts(text).length > 0;
}

/** The checks that failed — the report's whole point, as a list. */
export function premiseGaps(report: Pick<PremiseReport, "checks">): PremiseCheck[] {
  return report.checks.filter((c) => !c.ok);
}

/** The report as an agent/UI reads it — one line per claim, failures loud. */
export function premiseReportText(report: PremiseReport): string {
  const lines = [`Premise check (${report.ok ? "ok" : "FAILED CLAIMS"}):`];
  for (const c of report.checks) {
    lines.push(
      c.ok
        ? `- ${c.raw}: holds${c.detail ? ` (${c.detail})` : ""}`
        : `- ${c.raw}: FALSE — ${c.detail ?? "does not hold"}`,
    );
  }
  return lines.join("\n");
}

/**
 * The kickoff-prompt injection, or null when every claim held (or none were
 * made). Tells the manager the brief's premises are broken *and* what to do
 * about it — surface the discrepancy instead of building on a false floor.
 */
export function premiseGapPromptNote(report: PremiseReport | null | undefined): string | null {
  if (!report) return null;
  const gaps = premiseGaps(report);
  if (!gaps.length) return null;
  return [
    "FAILED PREMISES (checked at dispatch): the brief asserts things this repo says are false:",
    ...gaps.map((c) => `- ${c.raw} — ${c.detail ?? "does not hold"}`),
    "The plan was written against those claims. Do not silently work around them — raise " +
      "ask_question immediately with what you found, so the owner can correct the brief (or the " +
      "repo) before money is spent building on a false premise.",
  ].join("\n");
}
