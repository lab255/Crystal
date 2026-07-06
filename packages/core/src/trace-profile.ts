import { z } from "zod";
import type { CodeTrace } from "./codemap.js";

/**
 * Trace profile — a versioned interchange format for execution traces:
 * sampled stacks (CPU profiles), timed spans (APM-style), or anything else
 * that reduces to a weighted call tree. Files live in `.crystal/traces/` and
 * render as flamegraphs in the journey view, joining runtime behaviour onto
 * the static call graph via `file` + `symbol` refs.
 *
 * Spans are a flat list with parent pointers (not a nested tree) so profiles
 * are trivial to emit from any tool — `buildFlameTree` reassembles the tree.
 * Same compatibility contract as surveys: own `schemaVersion`, migrate-on-read,
 * tolerant parsing.
 */

export const TRACE_PROFILE_SCHEMA_VERSION = 1;

export const TraceSpanSchema = z.object({
  /** Profile-local id. */
  id: z.string(),
  /** Parent span id; null/absent for roots. */
  parentId: z.string().nullish(),
  /** Display name, e.g. "OrderController.create". */
  name: z.string(),
  /** Workspace-relative file, when known — links the span to the code map. */
  file: z.string().nullish(),
  /** Top-level symbol within `file`, when known. */
  symbol: z.string().nullish(),
  /**
   * Inclusive weight in `unit` (own time + children). Renderers derive self
   * time by subtracting children.
   */
  value: z.number().nonnegative(),
  /** Times this frame was entered, when the tracer counts calls. */
  calls: z.number().int().positive().nullish(),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceProfileSchema = z.object({
  schemaVersion: z.number().int().min(1),
  /** Display name, e.g. "checkout p99 2026-07-01". */
  name: z.string(),
  generator: z
    .object({ name: z.string(), version: z.string().default("") })
    .default({ name: "unknown", version: "" }),
  capturedAt: z.string().default(""),
  unit: z.enum(["samples", "microseconds", "milliseconds"]).catch("samples"),
  spans: z.array(TraceSpanSchema).default([]),
  notes: z.array(z.string()).default([]),
});
export type TraceProfile = z.infer<typeof TraceProfileSchema>;

/** Same shape as SURVEY_MIGRATIONS: `migrations[n]` upgrades n → n+1. */
export const TRACE_PROFILE_MIGRATIONS: Record<number, (data: unknown) => unknown> = {};

export class TraceProfileVersionError extends Error {}

export function migrateTraceProfileData(
  raw: unknown,
  migrations: Record<number, (data: unknown) => unknown> = TRACE_PROFILE_MIGRATIONS,
  currentVersion: number = TRACE_PROFILE_SCHEMA_VERSION,
): unknown {
  const version = (raw as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new TraceProfileVersionError(
      "Trace profile is missing an integer schemaVersion",
    );
  }
  if (version > currentVersion) {
    throw new TraceProfileVersionError(
      `Trace profile schemaVersion ${version} is newer than this build supports (${currentVersion})`,
    );
  }
  let data = raw;
  for (let v = version; v < currentVersion; v++) {
    const step = migrations[v];
    if (!step) {
      throw new TraceProfileVersionError(
        `No migration from trace profile schemaVersion ${v}`,
      );
    }
    data = step(data);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Flame tree                                                          */
/* ------------------------------------------------------------------ */

/** A resolved call-tree node ready for flamegraph rendering. */
export interface FlameNode {
  name: string;
  file: string | null;
  symbol: string | null;
  /** Inclusive weight (own + descendants). */
  total: number;
  /** Weight not attributed to children. */
  self: number;
  calls: number | null;
  depth: number;
  children: FlameNode[];
}

/**
 * Reassemble the span list into flame trees (one per root), computing self
 * time and dropping spans whose parent chain is broken or cyclic.
 */
export function buildFlameTree(profile: TraceProfile): FlameNode[] {
  const byId = new Map(profile.spans.map((s) => [s.id, s]));
  const nodes = new Map<string, FlameNode>();
  const roots: FlameNode[] = [];

  const resolve = (span: TraceSpan, seen: Set<string>): FlameNode | null => {
    const existing = nodes.get(span.id);
    if (existing) return existing;
    if (seen.has(span.id)) return null;
    seen.add(span.id);
    let parent: FlameNode | null = null;
    if (span.parentId != null) {
      const parentSpan = byId.get(span.parentId);
      if (!parentSpan) return null;
      parent = resolve(parentSpan, seen);
      if (!parent) return null;
    }
    const node: FlameNode = {
      name: span.name,
      file: span.file ?? null,
      symbol: span.symbol ?? null,
      total: span.value,
      self: span.value,
      calls: span.calls ?? null,
      depth: parent ? parent.depth + 1 : 0,
      children: [],
    };
    nodes.set(span.id, node);
    if (parent) {
      parent.children.push(node);
      parent.self = Math.max(0, parent.self - node.total);
    } else {
      roots.push(node);
    }
    return node;
  };

  for (const span of profile.spans) resolve(span, new Set());
  const sortDeep = (list: FlameNode[]) => {
    list.sort((a, b) => b.total - a.total);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}

/**
 * Build a flame tree from a *static* call trace: the BFS tree of the journey,
 * weighted by reachable-subtree size (a proxy for "how much code sits behind
 * this call"). Gives the journey a flamegraph before any runtime profile
 * exists; cycles and cross-links keep their first (shallowest) parent.
 */
export function flameTreeFromCodeTrace(trace: CodeTrace): FlameNode | null {
  if (trace.steps.length === 0) return null;
  const key = (ref: { file: string; symbol: string }) => `${ref.file}#${ref.symbol}`;
  const childKeys = new Map<string, string[]>();
  const claimed = new Set<string>([key(trace.entry)]);
  for (const edge of trace.edges) {
    const to = key(edge.to);
    if (claimed.has(to)) continue;
    claimed.add(to);
    const from = key(edge.from);
    childKeys.set(from, [...(childKeys.get(from) ?? []), to]);
  }
  const stepByKey = new Map(trace.steps.map((s) => [key(s.ref), s]));

  const build = (k: string, depth: number): FlameNode | null => {
    const step = stepByKey.get(k);
    if (!step) return null;
    const children = (childKeys.get(k) ?? [])
      .map((c) => build(c, depth + 1))
      .filter((n): n is FlameNode => n !== null);
    const total = 1 + children.reduce((sum, c) => sum + c.total, 0);
    return {
      name: step.ref.symbol,
      file: step.ref.file,
      symbol: step.ref.symbol,
      total,
      self: 1,
      calls: null,
      depth,
      children: children.sort((a, b) => b.total - a.total),
    };
  };
  return build(key(trace.entry), 0);
}
