import { z } from "zod";

/**
 * Recoverable-failure classification for agent runs.
 *
 * The Claude CLI reports every failure the same way — a nonzero exit and an
 * error string — but three failure classes are *recoverable* and each has
 * exactly one right recovery, so the run record carries a classification and
 * the UI renders the matching recovery affordance instead of a dead error:
 *
 *  - `context_overflow` — the session's context filled up. Recovery: hand the
 *    work off to a fresh session seeded with a summary (see `agent.handoff`).
 *  - `usage_limit` — the account's usage/rate limit was hit. Recovery: wait;
 *    `resetsAt` says until when, when the provider said.
 *  - `auth` — the CLI login is broken (expired OAuth, logged out, dead key).
 *    Recovery: re-authenticate the CLI (`claude /login`), then retry.
 *
 * Classification is regex batteries over provider/CLI error text. Patterns are
 * deliberately narrow: misclassifying a genuine failure as recoverable hides a
 * real bug behind a retry button, so unknown failures stay unclassified.
 */

export const RUN_FAILURE_KINDS = ["context_overflow", "usage_limit", "auth"] as const;
export const RunFailureKindSchema = z.enum(RUN_FAILURE_KINDS);
export type RunFailureKind = z.infer<typeof RunFailureKindSchema>;

export const RunFailureSchema = z.object({
  kind: RunFailureKindSchema,
  /** When the limit heals (ISO-8601), when the provider's error said. */
  resetsAt: z.string().nullish(),
  /** The provider line that matched, for display (capped). */
  detail: z.string().nullish(),
});
export type RunFailure = z.infer<typeof RunFailureSchema>;

const CONTEXT_OVERFLOW_RES = [
  /prompt is too long/i,
  /conversation (is )?too long/i,
  /exceeds? (the )?(model'?s )?(maximum )?context/i,
  /context (window|length|limit) (is |was |has been )?(exceeded|full|reached)/i,
  /input length and `?max_tokens`? exceed/i,
  /low on context/i,
] as const;

const USAGE_LIMIT_RES = [
  /usage limit reached/i,
  /you'?ve (hit|reached) your ([\w-]+ )?limit/i,
  /out of (extra )?usage/i,
  /rate[_ ]?limit(_error| reached| exceeded|ed)/i,
  /too many requests/i,
] as const;

const AUTH_RES = [
  /invalid (api key|x-api-key|bearer token)/i,
  /authentication[_ ]?(error|failed)/i,
  /(oauth|access) token (has )?(expired|been revoked)/i,
  /please run (`?\/?login`?|claude login)/i,
  /not logged in/i,
  /login required/i,
  /credit balance is too low/i,
  /permission[_ ]error.*api key/i,
] as const;

/** "…usage limit reached|1750000000" — the CLI appends the reset epoch. */
const EPOCH_SUFFIX_RE = /\|(\d{10,13})\s*$/;
/** Free-text reset hints: "resets at 3:00 PM", "reset in 2 hours". */
const RESETS_TEXT_RE = /resets? (?:at|in) ([^\n.,]+)/i;

/** ISO timestamp for an epoch that may be seconds or milliseconds. */
function epochToIso(raw: string): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const ms = raw.length >= 13 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The line of `text` that matched, trimmed and capped for display. */
function matchedLine(text: string, re: RegExp): string {
  const line = text.split(/\r?\n/).find((l) => re.test(l)) ?? text;
  const trimmed = line.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * Classify an error text into a recoverable failure, or null when it is not
 * one of the three recoverable classes. Order matters: overflow before usage
 * (an overflow message may also mention limits), auth last.
 */
export function classifyRunFailure(text: string | null | undefined): RunFailure | null {
  if (!text) return null;
  const batteries: readonly [RunFailureKind, readonly RegExp[]][] = [
    ["context_overflow", CONTEXT_OVERFLOW_RES],
    ["usage_limit", USAGE_LIMIT_RES],
    ["auth", AUTH_RES],
  ];
  for (const [kind, res] of batteries) {
    const hit = res.find((re) => re.test(text));
    if (!hit) continue;
    let resetsAt: string | null = null;
    if (kind === "usage_limit") {
      const epoch = EPOCH_SUFFIX_RE.exec(text);
      if (epoch) resetsAt = epochToIso(epoch[1]!);
      if (!resetsAt) {
        const worded = RESETS_TEXT_RE.exec(text);
        if (worded) resetsAt = worded[1]!.trim();
      }
    }
    return { kind, resetsAt, detail: matchedLine(text, hit) };
  }
  return null;
}

/** One-line recovery guidance for a classified failure (UI + run transcript). */
export function runFailureHint(failure: RunFailure): string {
  switch (failure.kind) {
    case "context_overflow":
      return "The session ran out of context. Hand off to a fresh session — the work so far is summarized and carried over.";
    case "usage_limit": {
      const when = failure.resetsAt ? formatResetsAt(failure.resetsAt) : null;
      return `Usage limit reached${when ? ` — resets ${when}` : ""}. The session can be retried once the limit resets.`;
    }
    case "auth":
      return "The Claude CLI login is broken (expired or logged out). Re-authenticate in a terminal (`claude /login`), then retry.";
  }
}

/** Human rendering of `resetsAt`: local time for ISO values, raw text otherwise. */
export function formatResetsAt(resetsAt: string): string {
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return resetsAt;
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? `at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : `${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}
