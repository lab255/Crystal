import { describe, expect, it } from "vitest";
import {
  createArchitectureGraph,
  createArchNode,
  type ArchEdgeKind,
  type ArchitectureGraph,
  type ArchNode,
} from "@crystal/core";
import {
  entryNodeIds,
  initialSimTickState,
  simulate,
  SPIKE_MULTIPLIER,
  RETRY_AMPLIFICATION,
  type SimInput,
  type SimTickState,
} from "./simulation.js";

let edgeSeq = 0;
function link(graph: ArchitectureGraph, source: ArchNode, target: ArchNode, kind: ArchEdgeKind = "sync") {
  const edge = { id: `e${edgeSeq++}`, source: source.id, target: target.id, kind, label: "" };
  graph.edges.push(edge);
  return edge;
}

function input(overrides: Partial<SimInput> = {}): SimInput {
  return {
    ingressRps: 100,
    chaos: { spike: false, cacheMissStorm: false, retryStorm: false },
    killed: new Set(),
    state: initialSimTickState(),
    ...overrides,
  };
}

/** client → lb → (a, b) → db */
function lbFixture() {
  const graph = createArchitectureGraph("t");
  const client = createArchNode("external", "client", { x: 0, y: 0 });
  const lb = createArchNode("loadbalancer", "lb", { x: 0, y: 100 });
  const a = createArchNode("service", "a", { x: -100, y: 200 });
  const b = createArchNode("service", "b", { x: 100, y: 200 });
  const db = createArchNode("datastore", "db", { x: 0, y: 300 });
  graph.nodes.push(client, lb, a, b, db);
  link(graph, client, lb);
  link(graph, lb, a);
  link(graph, lb, b);
  link(graph, a, db);
  link(graph, b, db);
  return { graph, client, lb, a, b, db };
}

/** client → svc → queue → worker (async through the queue). */
function queueFixture() {
  const graph = createArchitectureGraph("t");
  const client = createArchNode("external", "client", { x: 0, y: 0 });
  const svc = createArchNode("service", "svc", { x: 0, y: 100 });
  const queue = createArchNode("queue", "queue", { x: 0, y: 200 });
  const worker = createArchNode("service", "worker", { x: 0, y: 300 });
  graph.nodes.push(client, svc, queue, worker);
  link(graph, client, svc);
  link(graph, svc, queue, "async");
  link(graph, queue, worker, "async");
  return { graph, client, svc, queue, worker };
}

describe("simulation", () => {
  it("picks sources as entry nodes", () => {
    const { graph, client } = lbFixture();
    expect(entryNodeIds(graph)).toEqual([client.id]);
  });

  it("falls back to un-called components when there is no client", () => {
    const graph = createArchitectureGraph("t");
    const lb = createArchNode("loadbalancer", "lb", { x: 0, y: 0 });
    const svc = createArchNode("service", "svc", { x: 0, y: 100 });
    graph.nodes.push(lb, svc);
    link(graph, lb, svc);
    expect(entryNodeIds(graph)).toEqual([lb.id]);
  });

  it("splits load balancer traffic evenly with round-robin", () => {
    const { graph, a, b, db } = lbFixture();
    const result = simulate(graph, input({ ingressRps: 200 }));
    expect(result.nodes.get(a.id)!.inRps).toBeCloseTo(100, 0);
    expect(result.nodes.get(b.id)!.inRps).toBeCloseTo(100, 0);
    // Both services call the db: fan-in of both halves.
    expect(result.nodes.get(db.id)!.inRps).toBeCloseTo(200, 0);
    expect(result.totals.errorRate).toBeCloseTo(0, 2);
    expect(result.totals.throughputRps).toBeCloseTo(200, 0);
  });

  it("splits by capacity with the weighted algorithm", () => {
    const { graph, lb, a, b } = lbFixture();
    lb.sim = { replicas: 1, lbAlgorithm: "weighted" };
    a.sim = { replicas: 3 }; // 3× b's capacity
    const result = simulate(graph, input({ ingressRps: 200 }));
    expect(result.nodes.get(a.id)!.inRps).toBeCloseTo(150, 0);
    expect(result.nodes.get(b.id)!.inRps).toBeCloseTo(50, 0);
  });

  it("drops excess load as errors when a component saturates", () => {
    const { graph, db } = lbFixture();
    db.sim = { replicas: 1, capacityRps: 100 };
    const result = simulate(graph, input({ ingressRps: 400 }));
    const dbStats = result.nodes.get(db.id)!;
    expect(dbStats.overloaded).toBe(true);
    expect(dbStats.utilization).toBeGreaterThan(1);
    expect(dbStats.errorRate).toBeCloseTo(0.75, 1);
    // Failures propagate to the entry.
    expect(result.totals.errorRate).toBeGreaterThan(0.5);
    expect(result.totals.throughputRps).toBeLessThan(200);
  });

  it("adds replicas to absorb load", () => {
    const { graph, db } = lbFixture();
    db.sim = { replicas: 4, capacityRps: 100 };
    const result = simulate(graph, input({ ingressRps: 400 }));
    expect(result.nodes.get(db.id)!.errorRate).toBeCloseTo(0, 2);
  });

  it("caches shield the datastore; a miss storm floods it", () => {
    const graph = createArchitectureGraph("t");
    const client = createArchNode("external", "client", { x: 0, y: 0 });
    const svc = createArchNode("service", "svc", { x: 0, y: 100 });
    const cache = createArchNode("cache", "cache", { x: 0, y: 200 });
    const db = createArchNode("datastore", "db", { x: 0, y: 300 });
    graph.nodes.push(client, svc, cache, db);
    link(graph, client, svc);
    link(graph, svc, cache);
    link(graph, cache, db, "data");
    cache.sim = { replicas: 1, cacheHitRate: 0.9 };

    const calm = simulate(graph, input({ ingressRps: 1000 }));
    expect(calm.nodes.get(db.id)!.inRps).toBeCloseTo(100, 0);
    expect(calm.totals.cacheHitRate).toBeCloseTo(0.9, 5);

    const storm = simulate(
      graph,
      input({ ingressRps: 1000, chaos: { spike: false, cacheMissStorm: true, retryStorm: false } }),
    );
    expect(storm.nodes.get(db.id)!.inRps).toBeCloseTo(1000, 0);
    expect(storm.totals.cacheHitRate).toBe(0);
    // 1000 rps against the 600 rps default datastore: the storm hurts.
    expect(storm.totals.errorRate).toBeGreaterThan(calm.totals.errorRate);
  });

  it("traffic spike multiplies ingress", () => {
    const { graph, lb } = lbFixture();
    const result = simulate(
      graph,
      input({ ingressRps: 100, chaos: { spike: true, cacheMissStorm: false, retryStorm: false } }),
    );
    expect(result.totals.ingressRps).toBe(100 * SPIKE_MULTIPLIER);
    expect(result.nodes.get(lb.id)!.inRps).toBeCloseTo(100 * SPIKE_MULTIPLIER, 0);
  });

  it("killed components fail all their traffic and starve downstream", () => {
    const { graph, a, b, db } = lbFixture();
    const result = simulate(graph, input({ ingressRps: 200, killed: new Set([a.id]) }));
    expect(result.nodes.get(a.id)!.down).toBe(true);
    expect(result.nodes.get(a.id)!.errorRate).toBe(1);
    // Only b's half reaches the db.
    expect(result.nodes.get(db.id)!.inRps).toBeCloseTo(100, 0);
    // Half the entry traffic went to the dead service.
    expect(result.totals.errorRate).toBeCloseTo(0.5, 1);
  });

  it("circuit breaker opens under failure, cools down, then recovers", () => {
    const { graph, a, db } = lbFixture();
    a.sim = {
      replicas: 1,
      circuitBreaker: { enabled: true, errorThreshold: 0.5, cooldownTicks: 2 },
    };

    // Tick 1: a's downstream db is dead → a's error rate exceeds the threshold.
    const t1 = simulate(graph, input({ killed: new Set([db.id]) }));
    expect(t1.nodes.get(a.id)!.errorRate).toBe(1);
    expect(t1.state.breakers.get(a.id)!.phase).toBe("open");

    // Tick 2: breaker is open — a sheds everything, no probe yet.
    const t2 = simulate(graph, input({ killed: new Set([db.id]), state: t1.state }));
    expect(t2.nodes.get(a.id)!.breaker).toBe("open");
    expect(t2.nodes.get(a.id)!.servedRps).toBe(0);
    expect(t2.state.breakers.get(a.id)!.phase).toBe("open");

    // Tick 3: cooldown elapsed → half-open probe next tick.
    const t3 = simulate(graph, input({ killed: new Set([db.id]), state: t2.state }));
    expect(t3.state.breakers.get(a.id)!.phase).toBe("half-open");

    // Tick 4: db is back — probe succeeds, breaker closes.
    const t4 = simulate(graph, input({ state: t3.state }));
    expect(t4.nodes.get(a.id)!.breaker).toBe("half-open");
    expect(t4.state.breakers.get(a.id)!.phase).toBe("closed");

    // Tick 5: fully closed, traffic restored.
    const t5 = simulate(graph, input({ state: t4.state }));
    expect(t5.nodes.get(a.id)!.breaker).toBe("closed");
    expect(t5.nodes.get(a.id)!.errorRate).toBeCloseTo(0, 2);
  });

  it("async edges decouple errors", () => {
    const { graph, worker } = queueFixture();
    const result = simulate(graph, input({ ingressRps: 100, killed: new Set([worker.id]) }));
    // The worker is dead but the queue absorbs the writes — entry is unaffected.
    expect(result.nodes.get(worker.id)!.errorRate).toBe(1);
    expect(result.totals.errorRate).toBeCloseTo(0, 2);
  });

  it("queue backlog grows while consumers are down, then drains", () => {
    const { graph, queue, worker } = queueFixture();
    queue.sim = { replicas: 1, maxBacklog: 500 };

    // Consumers dead: 100 rps accumulates in the queue every tick.
    const t1 = simulate(graph, input({ killed: new Set([worker.id]) }));
    expect(t1.nodes.get(queue.id)!.backlog).toBeCloseTo(100, 0);
    const t2 = simulate(graph, input({ killed: new Set([worker.id]), state: t1.state }));
    expect(t2.nodes.get(queue.id)!.backlog).toBeCloseTo(200, 0);
    expect(t2.hints.some((h) => h.includes("Backlog growing"))).toBe(true);

    // Worker back: the backlog drains through it alongside new arrivals.
    const t3 = simulate(graph, input({ state: t2.state }));
    const q3 = t3.nodes.get(queue.id)!;
    expect(q3.backlog!).toBeLessThan(200);
    expect(t3.nodes.get(worker.id)!.inRps).toBeGreaterThan(100);
  });

  it("queue overflow drops messages once the backlog is full", () => {
    const { graph, queue, worker } = queueFixture();
    queue.sim = { replicas: 1, maxBacklog: 150 };

    const t1 = simulate(graph, input({ killed: new Set([worker.id]) }));
    const t2 = simulate(graph, input({ killed: new Set([worker.id]), state: t1.state }));
    // 200 arrived against a 150 cap: pinned at max, overflow drops as errors.
    expect(t2.nodes.get(queue.id)!.backlog).toBe(150);
    expect(t2.nodes.get(queue.id)!.errorRate).toBeGreaterThan(0);
    expect(t2.hints.some((h) => h.includes("overflowed"))).toBe(true);
  });

  it("queue splits work across competing consumers by healthy capacity", () => {
    const { graph, queue, worker } = queueFixture();
    const worker2 = createArchNode("service", "worker2", { x: 100, y: 300 });
    worker2.sim = { replicas: 3 };
    graph.nodes.push(worker2);
    link(graph, queue, worker2, "async");

    const result = simulate(graph, input({ ingressRps: 200 }));
    expect(result.nodes.get(worker2.id)!.inRps).toBeCloseTo(150, 0);
    expect(result.nodes.get(worker.id)!.inRps).toBeCloseTo(50, 0);

    // Kill worker: everything routes to worker2 — a pull model has health checks.
    const rerouted = simulate(graph, input({ ingressRps: 200, killed: new Set([worker.id]) }));
    expect(rerouted.nodes.get(worker2.id)!.inRps).toBeCloseTo(200, 0);
  });

  it("autoscaler adds replicas under load until errors stop, then scales back", () => {
    const { graph, db } = lbFixture();
    db.sim = {
      replicas: 1,
      capacityRps: 100,
      autoscale: { enabled: true, minReplicas: 1, maxReplicas: 8, targetUtilization: 0.7 },
    };

    // 400 rps against 100 rps/replica: heavy errors at first.
    let state: SimTickState = initialSimTickState();
    const first = simulate(graph, input({ ingressRps: 400 }));
    expect(first.nodes.get(db.id)!.errorRate).toBeGreaterThan(0.5);
    expect(first.nodes.get(db.id)!.scaling).toBe("up");

    state = first.state;
    for (let i = 0; i < 8; i++) state = simulate(graph, input({ ingressRps: 400, state })).state;
    const settled = simulate(graph, input({ ingressRps: 400, state }));
    expect(settled.nodes.get(db.id)!.replicas).toBeGreaterThanOrEqual(6);
    expect(settled.nodes.get(db.id)!.errorRate).toBeCloseTo(0, 2);

    // Load gone: scales back down toward the minimum.
    let calm = settled.state;
    for (let i = 0; i < 12; i++) calm = simulate(graph, input({ ingressRps: 10, state: calm })).state;
    const idle = simulate(graph, input({ ingressRps: 10, state: calm }));
    expect(idle.nodes.get(db.id)!.replicas).toBe(1);
  });

  it("hints when an autoscaler is pinned at its ceiling and still drowning", () => {
    const { graph, db } = lbFixture();
    db.sim = {
      replicas: 1,
      capacityRps: 50,
      autoscale: { enabled: true, minReplicas: 1, maxReplicas: 2, targetUtilization: 0.7 },
    };
    let state: SimTickState = initialSimTickState();
    for (let i = 0; i < 4; i++) state = simulate(graph, input({ ingressRps: 400, state })).state;
    const result = simulate(graph, input({ ingressRps: 400, state }));
    expect(result.nodes.get(db.id)!.replicas).toBe(2);
    expect(result.hints.some((h) => h.includes("replica ceiling"))).toBe(true);
  });

  it("retry storm amplifies ingress from last tick's error rate", () => {
    const { graph, db } = lbFixture();
    db.sim = { replicas: 1, capacityRps: 100 };
    const chaos = { spike: false, cacheMissStorm: false, retryStorm: true };

    const t1 = simulate(graph, input({ ingressRps: 400, chaos }));
    expect(t1.totals.retryMultiplier).toBe(1); // nothing failed yet
    expect(t1.totals.errorRate).toBeGreaterThan(0.5);

    // Failures retry: ingress climbs, which fails more — the death spiral.
    const t2 = simulate(graph, input({ ingressRps: 400, chaos, state: t1.state }));
    expect(t2.totals.retryMultiplier).toBeCloseTo(
      1 + RETRY_AMPLIFICATION * t1.totals.errorRate,
      5,
    );
    expect(t2.totals.ingressRps).toBeGreaterThan(t1.totals.ingressRps);
    expect(t2.totals.errorRate).toBeGreaterThan(t1.totals.errorRate);
  });

  it("latency climbs with utilization and includes downstream calls", () => {
    const { graph, db } = lbFixture();
    const idle = simulate(graph, input({ ingressRps: 10 }));
    db.sim = { replicas: 1, capacityRps: 210 };
    const busy = simulate(graph, input({ ingressRps: 200 }));
    expect(busy.totals.avgLatencyMs).toBeGreaterThan(idle.totals.avgLatencyMs);
    // Entry latency includes lb + service + db hops.
    expect(idle.totals.avgLatencyMs).toBeGreaterThan(30);
  });

  it("hints when there is no storage and when components saturate", () => {
    const graph = createArchitectureGraph("t");
    const client = createArchNode("external", "client", { x: 0, y: 0 });
    const svc = createArchNode("service", "svc", { x: 0, y: 100 });
    svc.sim = { replicas: 1, capacityRps: 50 };
    graph.nodes.push(client, svc);
    link(graph, client, svc);
    const result = simulate(graph, input({ ingressRps: 100 }));
    expect(result.hints.some((h) => h.includes("No storage"))).toBe(true);
    expect(result.hints.some((h) => h.includes("Over capacity"))).toBe(true);
  });

  it("flags a hot single-replica component as a single point of failure", () => {
    const graph = createArchitectureGraph("t");
    const client = createArchNode("external", "client", { x: 0, y: 0 });
    const svc = createArchNode("service", "svc", { x: 0, y: 100 });
    const db = createArchNode("datastore", "db", { x: 0, y: 200 });
    svc.sim = { replicas: 1, capacityRps: 1000 };
    graph.nodes.push(client, svc, db);
    link(graph, client, svc);
    link(graph, svc, db);
    const result = simulate(graph, input({ ingressRps: 700 }));
    expect(result.hints.some((h) => h.includes("single point of failure"))).toBe(true);
  });

  it("survives cycles without blowing up", () => {
    const graph = createArchitectureGraph("t");
    const client = createArchNode("external", "client", { x: 0, y: 0 });
    const a = createArchNode("service", "a", { x: 0, y: 100 });
    const b = createArchNode("service", "b", { x: 0, y: 200 });
    graph.nodes.push(client, a, b);
    link(graph, client, a);
    link(graph, a, b);
    link(graph, b, a); // cycle
    const result = simulate(graph, input({ ingressRps: 100 }));
    expect(Number.isFinite(result.nodes.get(a.id)!.inRps)).toBe(true);
    expect(result.nodes.get(a.id)!.inRps).toBeLessThan(10_000);
    expect(Number.isFinite(result.totals.avgLatencyMs)).toBe(true);
  });
});
