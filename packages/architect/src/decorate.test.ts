import { describe, expect, it } from "vitest";
import { decorateEdges, decorateNodes, type CanvasDecor } from "./decorate.js";
import type { HighlightRef } from "@crystal/core";
import type { Edge as RfEdge } from "@xyflow/react";

const NO_DECOR: CanvasDecor = {
  findMisses: null,
  flashId: null,
  hovered: null,
  hoverNeighborhood: null,
  externalHover: null,
  pinned: null,
};

const noChildRef = (): HighlightRef | null => null;

interface TestNode {
  id: string;
  parentId?: string;
  className?: string;
  data: Record<string, unknown>;
}

const node = (id: string, extra?: Partial<TestNode>): TestNode => ({
  id,
  data: {},
  ...extra,
});

describe("decorateNodes", () => {
  it("returns the input array itself when no decoration is active", () => {
    const nodes = [node("a"), node("b")];
    expect(decorateNodes(nodes, NO_DECOR, noChildRef)).toBe(nodes);
  });

  it("never touches node data and keeps undecorated nodes' identity", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const out = decorateNodes(
      nodes,
      { ...NO_DECOR, hovered: "a", hoverNeighborhood: new Set(["a", "b"]) },
      noChildRef,
    );
    expect(out).not.toBe(nodes);
    // The node outside the neighborhood is the same object.
    expect(out[2]).toBe(nodes[2]);
    // Decorated nodes are new objects but share the same data reference —
    // the regression this guards: hover must not churn `data` identities.
    expect(out[0]).not.toBe(nodes[0]);
    expect(out[0]!.data).toBe(nodes[0]!.data);
    expect(out[1]!.data).toBe(nodes[1]!.data);
  });

  it("spotlights only the hovered node's neighborhood; the walk goes child→ancestor, never downward to parents", () => {
    const nodes = [node("sys"), node("child", { parentId: "sys" }), node("other")];
    const out = decorateNodes(
      nodes,
      { ...NO_DECOR, hovered: "child", hoverNeighborhood: new Set(["child"]) },
      noChildRef,
    );
    expect(out[1]!.className).toContain("arch-hover-focus");
    expect(out[0]).toBe(nodes[0]);
    expect(out[2]).toBe(nodes[2]);
  });

  it("children of a lit container inherit the spotlight via the parent walk", () => {
    const nodes = [node("sys"), node("kid", { parentId: "sys" })];
    const out = decorateNodes(
      nodes,
      { ...NO_DECOR, hovered: "sys", hoverNeighborhood: new Set(["sys"]) },
      noChildRef,
    );
    expect(out[0]!.className).toContain("arch-hover-focus");
    expect(out[1]!.className).toContain("arch-hover-near");
  });

  it("dims find misses, including live-code children riding their parent's verdict", () => {
    const nodes = [node("m"), node("f:x", { parentId: "m" }), node("hit")];
    const out = decorateNodes(
      nodes,
      { ...NO_DECOR, findMisses: new Set(["m"]) },
      noChildRef,
    );
    expect(out[0]!.className).toContain("arch-find-miss");
    expect(out[1]!.className).toContain("arch-find-miss");
    expect(out[2]).toBe(nodes[2]);
  });

  it("appends to an existing className instead of replacing it", () => {
    const nodes = [node("a", { className: "lod-grow" })];
    const out = decorateNodes(nodes, { ...NO_DECOR, flashId: "a" }, noChildRef);
    expect(out[0]!.className).toContain("lod-grow");
    expect(out[0]!.className).toContain("arch-flash");
  });

  it("rings cross-view matches via data.hlRef without mutating data", () => {
    const ref: HighlightRef = { node: "sys:auth" };
    const nodes = [node("sys:auth", { data: { hlRef: ref } }), node("sys:other", { data: { hlRef: { node: "sys:other" } } })];
    const out = decorateNodes(nodes, { ...NO_DECOR, externalHover: { node: "sys:auth" } }, noChildRef);
    expect(out[0]!.className).toContain("hl-hover");
    expect(out[0]!.data).toBe(nodes[0]!.data);
  });
});

describe("decorateEdges", () => {
  const edge = (id: string, source: string, target: string): RfEdge => ({
    id,
    source,
    target,
    style: { stroke: "gray", opacity: 0.6 },
  });

  it("returns the input array itself when nothing is hovered", () => {
    const edges = [edge("e1", "a", "b")];
    expect(decorateEdges(edges, null)).toBe(edges);
  });

  it("recolors only adjacent edges, by direction, keeping the rest identical", () => {
    const edges = [edge("out", "hov", "b"), edge("in", "c", "hov"), edge("far", "x", "y")];
    const out = decorateEdges(edges, "hov");
    expect(out[0]!.style!.stroke).toBe("var(--color-accent-cyan)");
    expect(out[1]!.style!.stroke).toBe("var(--color-accent-emerald)");
    expect(out[2]).toBe(edges[2]);
  });
});
