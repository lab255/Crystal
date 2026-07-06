import {
  isContainerKind,
  type ArchEdge,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type LbAlgorithm,
} from "@crystal/core";

/**
 * Traffic simulation — an intuition sandbox, not a capacity planner.
 *
 * Requests enter at entry components and flow along sync/async/data edges.
 * Each component serves up to `capacityRps × replicas`; the excess is dropped
 * as errors and latency climbs as utilization approaches saturation. Load
 * balancers (and gateways) split traffic across their outgoing edges, caches
 * only forward misses, and everything else fans out — one downstream call per
 * dependency per request. Circuit breakers watch a component's error rate and
 * shed inbound load while open. The engine is pure and deterministic: one
 * `simulate` call is one tick, with breaker state threaded between ticks.
 */

/** Edge kinds that carry simulated traffic (dependency edges are static). */
const TRAFFIC_EDGE_KINDS = new Set<ArchEdge["kind"]>(["sync", "async", "data"]);
/** Async edges decouple: errors and latency do not propagate back through them. */
const COUPLED_EDGE_KINDS = new Set<ArchEdge["kind"]>(["sync", "data"]);

interface KindSimDefaults {
  capacityRps: number;
  latencyMs: number;
  cacheHitRate?: number;
}

/** Per-replica defaults; overridable per node via `node.sim`. */
export const KIND_SIM_DEFAULTS: Partial<Record<ArchNodeKind, KindSimDefaults>> = {
  frontend: { capacityRps: 5000, latencyMs: 5 },
  external: { capacityRps: 100_000, latencyMs: 40 },
  gateway: { capacityRps: 8000, latencyMs: 3 },
  loadbalancer: { capacityRps: 25_000, latencyMs: 1 },
  service: { capacityRps: 1000, latencyMs: 25 },
  repo: { capacityRps: 1000, latencyMs: 25 },
  datastore: { capacityRps: 600, latencyMs: 8 },
  cache: { capacityRps: 20_000, latencyMs: 1, cacheHitRate: 0.85 },
  queue: { capacityRps: 15_000, latencyMs: 2 },
};

export function isSimKind(kind: ArchNodeKind): boolean {
  return KIND_SIM_DEFAULTS[kind] != null;
}

/** Effective sim parameters of a node: explicit config over kind defaults. */
export function simParamsOf(node: ArchNode): {
  capacityRps: number;
  latencyMs: number;
  replicas: number;
  cacheHitRate: number | null;
  lbAlgorithm: LbAlgorithm;
} {
  const d = KIND_SIM_DEFAULTS[node.kind] ?? { capacityRps: 1000, latencyMs: 10 };
  return {
    capacityRps: node.sim?.capacityRps ?? d.capacityRps,
    latencyMs: node.sim?.latencyMs ?? d.latencyMs,
    replicas: node.sim?.replicas ?? 1,
    cacheHitRate:
      node.kind === "cache" ? (node.sim?.cacheHitRate ?? d.cacheHitRate ?? 0.85) : null,
    lbAlgorithm: node.sim?.lbAlgorithm ?? "round-robin",
  };
}

/* ---- display helpers shared by the sim UI ---- */

export function fmtRps(rps: number): string {
  if (rps >= 10_000) return `${Math.round(rps / 1000)}k`;
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k`;
  if (rps >= 10) return String(Math.round(rps));
  return rps.toFixed(1);
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function fmtPct(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export type BreakerPhase = "closed" | "open" | "half-open";
export interface BreakerState {
  phase: BreakerPhase;
  /** Ticks remaining before an open breaker probes again. */
  ticksLeft: number;
}

export interface SimChaos {
  /** Traffic spike: ingress multiplied. */
  spike: boolean;
  /** Cache-miss storm: every cache misses everything. */
  cacheMissStorm: boolean;
}

export interface SimInput {
  ingressRps: number;
  chaos: SimChaos;
  /** Components toggled off (crashed) — the per-node kill switch. */
  killed: ReadonlySet<string>;
  /** Breaker state from the previous tick; empty map on the first tick. */
  breakers: ReadonlyMap<string, BreakerState>;
}

export interface SimNodeStats {
  inRps: number;
  servedRps: number;
  /** inbound / effective capacity; > 1 means the component is shedding load. */
  utilization: number;
  /** Failure fraction seen by callers of this node, downstream included. */
  errorRate: number;
  /** Latency from this node down its coupled dependencies. */
  latencyMs: number;
  down: boolean;
  breaker: BreakerPhase | null;
  overloaded: boolean;
  /** Effective hit rate this tick (cache nodes only). */
  cacheHitRate: number | null;
}

export interface SimTotals {
  ingressRps: number;
  /** Successfully served requests per second, measured at the entries. */
  throughputRps: number;
  errorRate: number;
  avgLatencyMs: number;
  /** Traffic-weighted across cache nodes; null when the design has none. */
  cacheHitRate: number | null;
}

export interface SimResult {
  nodes: Map<string, SimNodeStats>;
  /** Edge id → requests/second flowing along it this tick. */
  edges: Map<string, number>;
  totals: SimTotals;
  /** Next-tick breaker state — feed back into the next `simulate` call. */
  breakers: Map<string, BreakerState>;
  hints: string[];
}

export const SPIKE_MULTIPLIER = 4;
/** Fraction of inbound a half-open breaker lets through to probe recovery. */
const HALF_OPEN_PROBE = 0.1;
/** Fixed-point rounds for load propagation (bounded for cyclic graphs). */
const MAX_ROUNDS = 32;
const EPSILON_RPS = 0.25;

/** Requests below this inbound don't trip breakers (noise floor). */
const BREAKER_MIN_RPS = 0.5;

interface SimNode {
  node: ArchNode;
  params: ReturnType<typeof simParamsOf>;
  /** capacityRps × replicas. */
  capacity: number;
  outEdges: ArchEdge[];
  inCount: number;
  down: boolean;
  breaker: BreakerState | null;
}

function buildSimNodes(graph: ArchitectureGraph, input: SimInput): Map<string, SimNode> {
  const sim = new Map<string, SimNode>();
  for (const node of graph.nodes) {
    if (isContainerKind(node.kind) || !isSimKind(node.kind)) continue;
    const params = simParamsOf(node);
    const cb = node.sim?.circuitBreaker;
    sim.set(node.id, {
      node,
      params,
      capacity: params.capacityRps * params.replicas,
      outEdges: [],
      inCount: 0,
      down: input.killed.has(node.id),
      breaker: cb?.enabled
        ? (input.breakers.get(node.id) ?? { phase: "closed", ticksLeft: 0 })
        : null,
    });
  }
  for (const edge of graph.edges) {
    if (!TRAFFIC_EDGE_KINDS.has(edge.kind)) continue;
    const source = sim.get(edge.source);
    const target = sim.get(edge.target);
    if (!source || !target || edge.source === edge.target) continue;
    source.outEdges.push(edge);
    target.inCount++;
  }
  return sim;
}

/** Where ingress traffic lands: sources first, then any component nobody calls. */
export function entryNodeIds(graph: ArchitectureGraph): string[] {
  const sim = buildSimNodes(graph, {
    ingressRps: 0,
    chaos: { spike: false, cacheMissStorm: false },
    killed: new Set(),
    breakers: new Map(),
  });
  const roots = [...sim.values()].filter((s) => s.inCount === 0);
  const sources = roots.filter((s) => s.node.kind === "external" || s.node.kind === "frontend");
  const picked = sources.length > 0 ? sources : roots;
  return picked.map((s) => s.node.id);
}

/** Fraction of inbound a node serves given its kill/breaker gates. */
function gateOf(s: SimNode): number {
  if (s.down) return 0;
  if (!s.breaker) return 1;
  if (s.breaker.phase === "open") return 0;
  if (s.breaker.phase === "half-open") return HALF_OPEN_PROBE;
  return 1;
}

/** Split a load balancer's served traffic across its outgoing edges. */
function lbShares(
  s: SimNode,
  sim: Map<string, SimNode>,
  inbound: Map<string, number>,
): number[] {
  const edges = s.outEdges;
  if (edges.length === 0) return [];
  const weights = edges.map((e) => {
    const target = sim.get(e.target)!;
    switch (s.params.lbAlgorithm) {
      case "weighted":
        return target.down ? 0 : target.capacity;
      case "least-loaded": {
        if (target.down) return 0;
        const headroom = target.capacity - (inbound.get(e.target) ?? 0);
        return Math.max(headroom, target.capacity * 0.02);
      }
      default:
        // Plain round-robin has no health checks — it sprays at dead targets.
        return 1;
    }
  });
  const total = weights.reduce((a, b) => a + b, 0);
  // All targets down: spray evenly so the failure is visible downstream.
  if (total <= 0) return edges.map(() => 1 / edges.length);
  return weights.map((w) => w / total);
}

export function simulate(graph: ArchitectureGraph, input: SimInput): SimResult {
  const sim = buildSimNodes(graph, input);
  const hints: string[] = [];

  const entries = entryNodeIds(graph).filter((id) => sim.has(id));
  const ingress = input.ingressRps * (input.chaos.spike ? SPIKE_MULTIPLIER : 1);

  if (sim.size > 0 && entries.length === 0) {
    hints.push("No entry point — every component is called by another. Add a frontend or external client.");
  }
  if (sim.size > 0 && ![...sim.values()].some((s) => s.node.kind === "datastore" || s.node.kind === "cache")) {
    hints.push("No storage — most designs need a datastore or cache.");
  }

  /* ---- load propagation: fixed-point over inbound rps ---- */
  const seed = new Map<string, number>();
  for (const id of entries) seed.set(id, ingress / entries.length);

  let inbound = new Map<string, number>(seed);
  let edgeFlow = new Map<string, number>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = new Map<string, number>(seed);
    const flows = new Map<string, number>();
    for (const [id, rps] of inbound) {
      const s = sim.get(id);
      if (!s || rps <= EPSILON_RPS) continue;
      const served = Math.min(rps * gateOf(s), s.capacity);
      if (served <= EPSILON_RPS || s.outEdges.length === 0) continue;
      const splits = s.node.kind === "loadbalancer" || s.node.kind === "gateway";
      const hitRate = s.node.kind === "cache"
        ? (input.chaos.cacheMissStorm ? 0 : (s.params.cacheHitRate ?? 0))
        : 0;
      const forwarded = s.node.kind === "cache" ? served * (1 - hitRate) : served;
      const shares = splits ? lbShares(s, sim, inbound) : null;
      s.outEdges.forEach((e, i) => {
        const amount = shares ? forwarded * (shares[i] ?? 0) : forwarded;
        if (amount <= 0) return;
        flows.set(e.id, (flows.get(e.id) ?? 0) + amount);
        next.set(e.target, (next.get(e.target) ?? 0) + amount);
      });
    }
    let delta = 0;
    for (const [id, v] of next) delta = Math.max(delta, Math.abs(v - (inbound.get(id) ?? 0)));
    for (const [id, v] of inbound) if (!next.has(id)) delta = Math.max(delta, v);
    inbound = next;
    edgeFlow = flows;
    if (delta < EPSILON_RPS) break;
  }

  /* ---- quality: errors + latency, walked down coupled edges ---- */
  interface Quality {
    /** Failure fraction seen by callers (shed by breakers included). */
    err: number;
    /** Failure fraction among admitted requests only — what breakers judge. */
    errServed: number;
    lat: number;
  }
  const quality = new Map<string, Quality>();
  const walking = new Set<string>();
  const qualityOf = (id: string): Quality => {
    const cached = quality.get(id);
    if (cached) return cached;
    if (walking.has(id)) return { err: 0, errServed: 0, lat: 0 }; // cycle: stop the walk
    const s = sim.get(id);
    if (!s) return { err: 0, errServed: 0, lat: 0 };
    walking.add(id);

    let result: Quality;
    const rps = inbound.get(id) ?? 0;
    if (s.down || s.breaker?.phase === "open") {
      result = { err: 1, errServed: 1, lat: 2 }; // fast failure
    } else {
      const gate = gateOf(s);
      const admitted = rps * gate;
      const served = Math.min(admitted, s.capacity);
      // Requests rejected by a half-open breaker fail fast, like an open one.
      const shed = rps > 0 ? (rps - admitted) / rps : 0;
      const dropped = admitted > 0 ? (admitted - served) / admitted : 0;
      const u = s.capacity > 0 ? rps / s.capacity : 0;
      // Queueing curve: latency climbs steeply near saturation, capped at 6×.
      const congestion = Math.min(u, 1);
      let errServed = Math.min(dropped, 1);
      let lat = s.params.latencyMs * (1 + 5 * congestion ** 4);
      for (const e of s.outEdges) {
        if (!COUPLED_EDGE_KINDS.has(e.kind)) continue;
        // Cache misses and LB splits are already baked into the edge flow, so
        // `share` is the fraction of this node's requests that hit the target.
        const flow = edgeFlow.get(e.id) ?? 0;
        if (flow <= 0) continue;
        const share = served > 0 ? Math.min(flow / served, 1) : 0;
        const q = qualityOf(e.target);
        errServed = 1 - (1 - errServed) * (1 - share * q.err);
        lat += share * q.lat;
      }
      errServed = Math.min(errServed, 1);
      result = { err: Math.min(shed + (1 - shed) * errServed, 1), errServed, lat };
    }
    walking.delete(id);
    quality.set(id, result);
    return result;
  };

  /* ---- assemble per-node stats ---- */
  const nodes = new Map<string, SimNodeStats>();
  for (const [id, s] of sim) {
    const rps = inbound.get(id) ?? 0;
    const served = Math.min(rps * gateOf(s), s.capacity);
    const q = qualityOf(id);
    const u = s.capacity > 0 ? rps / s.capacity : 0;
    nodes.set(id, {
      inRps: rps,
      servedRps: served,
      utilization: u,
      errorRate: q.err,
      latencyMs: q.lat,
      down: s.down,
      breaker: s.breaker?.phase ?? null,
      overloaded: !s.down && u > 1,
      cacheHitRate:
        s.node.kind === "cache"
          ? (input.chaos.cacheMissStorm ? 0 : (s.params.cacheHitRate ?? 0))
          : null,
    });
  }

  /* ---- breaker transitions for the next tick ---- */
  const breakers = new Map<string, BreakerState>();
  for (const [id, s] of sim) {
    if (!s.breaker) continue;
    const cb = s.node.sim!.circuitBreaker!;
    const stats = nodes.get(id)!;
    let next: BreakerState;
    const servedErr = quality.get(id)?.errServed ?? 0;
    switch (s.breaker.phase) {
      case "closed":
        next =
          stats.inRps > BREAKER_MIN_RPS && servedErr >= cb.errorThreshold
            ? { phase: "open", ticksLeft: cb.cooldownTicks }
            : { phase: "closed", ticksLeft: 0 };
        break;
      case "open":
        next =
          s.breaker.ticksLeft <= 1
            ? { phase: "half-open", ticksLeft: 0 }
            : { phase: "open", ticksLeft: s.breaker.ticksLeft - 1 };
        break;
      case "half-open":
        // Judge only the probe traffic that actually went through this tick.
        next =
          stats.inRps > BREAKER_MIN_RPS && servedErr >= cb.errorThreshold
            ? { phase: "open", ticksLeft: cb.cooldownTicks }
            : { phase: "closed", ticksLeft: 0 };
        break;
    }
    breakers.set(id, next);
  }

  /* ---- totals, measured at the entries ---- */
  let errorRate = 0;
  let avgLatencyMs = 0;
  for (const id of entries) {
    const q = qualityOf(id);
    const w = 1 / entries.length;
    errorRate += w * q.err;
    avgLatencyMs += w * q.lat;
  }
  const caches = [...sim.values()].filter((s) => s.node.kind === "cache");
  let cacheHitRate: number | null = null;
  if (caches.length > 0) {
    let weight = 0;
    let acc = 0;
    for (const c of caches) {
      const rps = Math.max(inbound.get(c.node.id) ?? 0, 0.001);
      const hit = input.chaos.cacheMissStorm ? 0 : (c.params.cacheHitRate ?? 0);
      acc += rps * hit;
      weight += rps;
    }
    cacheHitRate = acc / weight;
  }

  const overloaded = [...nodes.entries()].filter(([, s]) => s.overloaded);
  if (overloaded.length > 0) {
    const names = overloaded
      .slice(0, 3)
      .map(([id]) => sim.get(id)!.node.label)
      .join(", ");
    hints.push(
      `Over capacity: ${names}${overloaded.length > 3 ? ` +${overloaded.length - 3}` : ""} — add replicas or a cache.`,
    );
  }

  return {
    nodes,
    edges: edgeFlow,
    totals: {
      ingressRps: ingress,
      throughputRps: entries.length > 0 ? ingress * (1 - errorRate) : 0,
      errorRate: entries.length > 0 ? errorRate : 0,
      avgLatencyMs: entries.length > 0 ? avgLatencyMs : 0,
      cacheHitRate,
    },
    breakers,
    hints,
  };
}
