import { z } from "zod";
import { uid } from "./ids.js";

/**
 * Managed services — long-running workspace commands (dev servers, Storybook,
 * watchers) supervised by the bridge server. Definitions are durable and
 * belong to the repo (`.crystal/services.json`); runtime state (pid, status,
 * logs) is server-owned and ephemeral. Borrowed from operator-oss's services
 * supervisor: detached process groups owned by the server, desired-state
 * persistence so `running` services restart with it, port pre-probing, and a
 * bounded log ring.
 */

export const SERVICE_KINDS = ["dev", "setup", "test", "other"] as const;
export const ServiceKindSchema = z.enum(SERVICE_KINDS);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const ServiceDefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** Shell command line, run via the platform shell in `cwd`. */
  command: z.string().min(1),
  /** Working directory relative to the workspace root. */
  cwd: z.string().default("."),
  /** What the command is for — drives ordering and small UI affordances. */
  kind: ServiceKindSchema.default("dev"),
  /**
   * Port the service is expected to bind. Pre-probed before start so a taken
   * port surfaces as a readable error instead of an EADDRINUSE crash-loop;
   * also what preview iframes point at.
   */
  port: z.number().int().min(1).max(65535).nullish(),
  /** Extra environment for the process (values are never logged). */
  env: z.record(z.string(), z.string()).default({}),
});
export type ServiceDef = z.infer<typeof ServiceDefSchema>;

/** Longest accepted watch pattern (a bound, not a suggestion). */
export const WATCH_PATTERN_MAX = 256;
/** Default watch throttle (schema default AND what the UI helper text states). */
export const WATCH_DEFAULT_MIN_INTERVAL_SEC = 300;
/** Per-service log ring cap — the server keeps (and the UI trims to) this many lines. */
export const SERVICE_LOG_RING = 1500;

/** Why a watch fired. */
export type WatchFireReason =
  | { kind: "log"; line: string }
  | { kind: "crash"; detail: string };

/**
 * A watch — wake an agent when a service crashes or its log matches. The
 * pattern language is deliberately NOT regex (a bad pattern must never wedge
 * the log loop): literal alternatives separated by `|`, each optionally
 * anchored with `^`/`$`, matched case-insensitively. E.g. `ERROR|^FATAL`.
 * Borrowed from qm's monitor broker.
 */
export const WatchDefSchema = z.object({
  id: z.string(),
  /** Service this watch is attached to. */
  serviceId: z.string(),
  /** Literal-alternatives log pattern (see above); empty = exit-only watch. */
  pattern: z.string().max(WATCH_PATTERN_MAX).default(""),
  /** Also fire when the service crashes (exits while supposed to be running). */
  onCrash: z.boolean().default(true),
  /** What the dispatched agent should do about it. */
  instructions: z.string().min(1),
  /** Throttle: never fire more often than this. */
  minIntervalSec: z.number().int().min(10).default(WATCH_DEFAULT_MIN_INTERVAL_SEC),
  enabled: z.boolean().default(true),
});
export type WatchDef = z.infer<typeof WatchDefSchema>;

export function createWatchDef(init: {
  serviceId: string;
  pattern?: string;
  onCrash?: boolean;
  instructions: string;
}): WatchDef {
  return WatchDefSchema.parse({
    id: uid("watch"),
    serviceId: init.serviceId,
    pattern: init.pattern ?? "",
    onCrash: init.onCrash ?? true,
    instructions: init.instructions,
  });
}

export const ServicesFileSchema = z.object({
  services: z.array(ServiceDefSchema).default([]),
  watches: z.array(WatchDefSchema).default([]),
});
export type ServicesFile = z.infer<typeof ServicesFileSchema>;

export function createServicesFile(): ServicesFile {
  return { services: [], watches: [] };
}

export function createServiceDef(init: {
  name: string;
  command: string;
  cwd?: string;
  kind?: ServiceKind;
  port?: number | null;
}): ServiceDef {
  return ServiceDefSchema.parse({
    id: uid("svc"),
    name: init.name,
    command: init.command,
    cwd: init.cwd ?? ".",
    kind: init.kind ?? "dev",
    port: init.port ?? null,
  });
}

export const SERVICE_STATUSES = ["stopped", "starting", "running", "exited", "failed"] as const;
export const ServiceStatusSchema = z.enum(SERVICE_STATUSES);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

/** A definition plus its live supervision state, as served over the bridge. */
export interface ServiceInfo {
  def: ServiceDef;
  status: ServiceStatus;
  /** Process-group leader pid while live. */
  pid: number | null;
  /** Exit code of the last run (null while live / never started / signalled). */
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Human-readable failure (spawn error, port conflict) for the last run. */
  lastError: string | null;
  /**
   * The user's intent — "running" services are restarted when the server
   * boots; an `exited`/`failed` status against a `running` desire is a crash.
   */
  desired: "running" | "stopped";
}

/** One log line from a service, sequenced per service for replay + tail. */
export interface ServiceLogChunk {
  serviceId: string;
  seq: number;
  ts: string;
  /** Line text (stdout and stderr interleaved, newline-stripped). */
  text: string;
}

/** A watch definition plus its live counters, as served over the bridge. */
export interface WatchInfo {
  def: WatchDef;
  lastFiredAt: string | null;
  fireCount: number;
}

/** The prompt for an agent dispatched by a fired watch. */
export function buildWatchFirePrompt(args: {
  serviceName: string;
  command: string;
  reason: WatchFireReason;
  instructions: string;
  logTail: string[];
}): string {
  const trigger =
    args.reason.kind === "log"
      ? `its log matched a watch pattern:\n    ${args.reason.line}`
      : `it crashed: ${args.reason.detail}`;
  return [
    `[Watch fired] The managed service "${args.serviceName}" (\`${args.command}\`) needs attention — ${trigger}`,
    "",
    "Recent service log (oldest first):",
    "```",
    ...args.logTail,
    "```",
    "",
    "Your task:",
    args.instructions,
    "",
    "This is an automated wake, not a human request: investigate before changing anything. " +
      "If the problem is transient or already resolved, say so briefly and stop.",
  ].join("\n");
}

/**
 * Compile a watch pattern into a line predicate. Alternatives are LITERAL
 * (never regex) with optional `^`/`$` anchors, case-insensitive. Returns null
 * for an empty/whitespace pattern (an exit-only watch) — invalid input can't
 * exist beyond the length bound, which the schema already enforces.
 */
export function compileWatchPattern(pattern: string): ((line: string) => boolean) | null {
  const alternatives = pattern
    .slice(0, WATCH_PATTERN_MAX)
    .split("|")
    .map((a) => a.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return null;
  const tests = alternatives.map((alt) => {
    const anchoredStart = alt.startsWith("^");
    const anchoredEnd = alt.endsWith("$") && alt.length > 1;
    const literal = alt
      .slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined)
      .toLowerCase();
    return (line: string) => {
      if (!literal) return false;
      const l = line.toLowerCase();
      if (anchoredStart && anchoredEnd) return l === literal;
      if (anchoredStart) return l.startsWith(literal);
      if (anchoredEnd) return l.endsWith(literal);
      return l.includes(literal);
    };
  });
  return (line) => tests.some((t) => t(line));
}
