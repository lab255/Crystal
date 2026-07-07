import { describe, expect, it } from "vitest";
import {
  createArchFacet,
  createArchitectureGraph,
  facetVisibleIds,
  filterGraphToFacet,
  type ArchEdge,
  type ArchNode,
} from "./architecture.js";

const node = (id: string, parentId: string | null = null, kind: ArchNode["kind"] = "service"): ArchNode => ({
  id,
  kind,
  label: id,
  description: "",
  parentId,
  position: { x: 0, y: 0 },
  size: null,
  tech: [],
  placements: {},
});

const edge = (id: string, source: string, target: string): ArchEdge => ({
  id,
  source,
  target,
  kind: "sync",
  label: "",
});

/**
 *   pkg (group)
 *   ├── core
 *   └── client
 *   auth
 *   db
 *   edges: auth→core, client→db, auth→db
 */
function graph() {
  return {
    ...createArchitectureGraph("test"),
    nodes: [
      node("pkg", null, "group"),
      node("core", "pkg"),
      node("client", "pkg"),
      node("auth"),
      node("db", null, "datastore"),
    ],
    edges: [edge("e1", "auth", "core"), edge("e2", "client", "db"), edge("e3", "auth", "db")],
  };
}

describe("facetVisibleIds", () => {
  it("shows members plus their ancestors", () => {
    const visible = facetVisibleIds(graph(), createArchFacet("auth view", ["core", "auth"]));
    expect([...visible].sort()).toEqual(["auth", "core", "pkg"]);
  });

  it("member containers bring their descendants", () => {
    const visible = facetVisibleIds(graph(), createArchFacet("packages", ["pkg"]));
    expect([...visible].sort()).toEqual(["client", "core", "pkg"]);
  });

  it("ignores dangling member ids", () => {
    const visible = facetVisibleIds(graph(), createArchFacet("stale", ["gone", "db"]));
    expect([...visible].sort()).toEqual(["db"]);
  });

  it("an empty (or fully dangling) facet shows the whole diagram", () => {
    const g = graph();
    expect(facetVisibleIds(g, createArchFacet("empty")).size).toBe(g.nodes.length);
    expect(facetVisibleIds(g, createArchFacet("stale", ["gone"])).size).toBe(g.nodes.length);
  });
});

describe("filterGraphToFacet", () => {
  it("keeps only edges with both endpoints visible, order preserved", () => {
    const filtered = filterGraphToFacet(graph(), createArchFacet("auth view", ["auth", "db"]));
    expect(filtered.nodes.map((n) => n.id)).toEqual(["auth", "db"]);
    expect(filtered.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("returns the graph unchanged when everything is visible", () => {
    const g = graph();
    expect(filterGraphToFacet(g, createArchFacet("empty"))).toBe(g);
  });

  it("never touches geometry", () => {
    const g = graph();
    g.nodes[1] = { ...g.nodes[1]!, position: { x: 123, y: 456 } };
    const filtered = filterGraphToFacet(g, createArchFacet("f", ["core"]));
    expect(filtered.nodes.find((n) => n.id === "core")?.position).toEqual({ x: 123, y: 456 });
  });
});
