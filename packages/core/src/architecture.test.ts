import { describe, expect, it } from "vitest";
import {
  createArchitectureGraph,
  createArchNode,
  descendantsOf,
  topoOrderNodes,
  wouldCreateCycle,
} from "./architecture.js";

function fixture() {
  const graph = createArchitectureGraph("t");
  const sys = createArchNode("system", "sys", { x: 0, y: 0 });
  const grp = createArchNode("group", "grp", { x: 10, y: 10 }, sys.id);
  const svc = createArchNode("service", "svc", { x: 20, y: 20 }, grp.id);
  const lone = createArchNode("datastore", "db", { x: 500, y: 0 });
  // Intentionally child-before-parent order to exercise topo sorting.
  graph.nodes.push(svc, grp, sys, lone);
  return { graph, sys, grp, svc, lone };
}

describe("architecture helpers", () => {
  it("computes transitive descendants", () => {
    const { graph, sys, grp, svc } = fixture();
    const ids = descendantsOf(graph, sys.id).map((n) => n.id).sort();
    expect(ids).toEqual([grp.id, svc.id].sort());
  });

  it("detects reparenting cycles", () => {
    const { graph, sys, grp, svc, lone } = fixture();
    expect(wouldCreateCycle(graph, sys.id, svc.id)).toBe(true);
    expect(wouldCreateCycle(graph, sys.id, sys.id)).toBe(true);
    expect(wouldCreateCycle(graph, grp.id, sys.id)).toBe(false);
    expect(wouldCreateCycle(graph, lone.id, grp.id)).toBe(false);
  });

  it("orders parents before children for react-flow", () => {
    const { graph, sys, grp, svc } = fixture();
    const ordered = topoOrderNodes(graph).map((n) => n.id);
    expect(ordered.indexOf(sys.id)).toBeLessThan(ordered.indexOf(grp.id));
    expect(ordered.indexOf(grp.id)).toBeLessThan(ordered.indexOf(svc.id));
    expect(ordered).toHaveLength(graph.nodes.length);
  });
});
