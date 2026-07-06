import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";
import { autoLayout, scopeIsFullstack, scopeLayerOf } from "./layout.js";

function node(id: string, kind: ArchNodeKind, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), ...patch, id };
}

function graph(nodes: ArchNode[], edges: ArchitectureGraph["edges"] = []): ArchitectureGraph {
  return { ...createArchitectureGraph("g"), id: "arch_1", environments: [], nodes, edges };
}

const topOf = (g: ArchitectureGraph, id: string) => g.nodes.find((n) => n.id === id)!.position.y;

describe("autoLayout — flow mode", () => {
  it("assigns finite positions to every node", () => {
    const g = graph(
      [node("a", "service"), node("b", "datastore")],
      [{ id: "e", source: "a", target: "b", kind: "sync", label: "" }],
    );
    const laid = autoLayout(g);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});

describe("autoLayout — layers mode", () => {
  it("stacks entry above service above data (backend-only scope)", () => {
    const g = graph([
      node("db", "datastore"),
      node("api", "service"),
      node("gw", "gateway"),
      node("ext", "external"),
      node("q", "queue"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "gw")).toBeLessThan(topOf(laid, "api"));
    expect(topOf(laid, "ext")).toBeLessThan(topOf(laid, "api"));
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "db"));
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "q"));
    // Nodes in the same band share a top edge.
    expect(topOf(laid, "gw")).toBe(topOf(laid, "ext"));
  });

  it("respects explicit layer overrides", () => {
    const g = graph([
      node("mw", "service", { layer: "entry" }), // middleware pinned to the entry tier
      node("api", "service"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "mw")).toBeLessThan(topOf(laid, "api"));
  });

  it("keeps container children parent-relative and banded within the scope", () => {
    const g = graph([
      node("sys", "system"),
      node("gw", "gateway", { parentId: "sys" }),
      node("db", "datastore", { parentId: "sys" }),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    // Children positions are parent-relative: inside the container's padding.
    expect(topOf(laid, "gw")).toBeGreaterThanOrEqual(48);
    expect(topOf(laid, "gw")).toBeLessThan(topOf(laid, "db"));
  });
});

const leftOf = (g: ArchitectureGraph, id: string) => g.nodes.find((n) => n.id === id)!.position.x;

describe("autoLayout — fullstack scopes", () => {
  it("lays mixed frontend + backend scopes out left-to-right across the stack", () => {
    const g = graph([
      node("db", "datastore"),
      node("api", "service"),
      node("gw", "gateway"),
      node("web", "frontend"),
    ]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(leftOf(laid, "web")).toBeLessThan(leftOf(laid, "gw"));
    expect(leftOf(laid, "gw")).toBeLessThan(leftOf(laid, "api"));
    expect(leftOf(laid, "api")).toBeLessThan(leftOf(laid, "db"));
  });

  it("keeps backend-only scopes vertical", () => {
    const g = graph([node("db", "datastore"), node("api", "service")]);
    const laid = autoLayout(g, { mode: "layers" });
    expect(topOf(laid, "api")).toBeLessThan(topOf(laid, "db"));
    expect(scopeIsFullstack(g, ["db", "api"])).toBe(false);
  });

  it("treats containers by their majority descendants", () => {
    const g = graph([
      node("apps", "group"),
      node("web", "frontend", { parentId: "apps" }),
      node("svc", "service"),
    ]);
    expect(scopeIsFullstack(g, ["apps", "svc"])).toBe(true);
    const laid = autoLayout(g, { mode: "layers" });
    expect(leftOf(laid, "apps")).toBeLessThan(leftOf(laid, "svc"));
  });
});

describe("scopeLayerOf", () => {
  it("bands containers by the majority layer of their descendants", () => {
    const g = graph([
      node("grp", "group"),
      node("db1", "datastore", { parentId: "grp" }),
      node("db2", "datastore", { parentId: "grp" }),
      node("svc", "service", { parentId: "grp" }),
    ]);
    expect(scopeLayerOf(g, g.nodes[0]!)).toBe("data");
  });

  it("prefers an explicit override on the container itself", () => {
    const g = graph([
      node("grp", "group", { layer: "entry" }),
      node("db", "datastore", { parentId: "grp" }),
    ]);
    expect(scopeLayerOf(g, g.nodes[0]!)).toBe("entry");
  });
});
