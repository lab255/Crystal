import { describe, expect, it } from "vitest";
import { createNavStore } from "./nav-store.js";

describe("nav store", () => {
  it("merges section patches field-by-field", () => {
    const store = createNavStore({ mode: "architect", architect: { view: "architecture" } });
    store.getState().update({ architect: { facet: "facet-1" } });
    expect(store.getState().link.architect).toEqual({ view: "architecture", facet: "facet-1" });
  });

  it("clears fields with null and drops empty sections", () => {
    const store = createNavStore({ mode: "code", code: { file: "a.ts" } });
    store.getState().update({ code: { file: null } });
    expect(store.getState().link.code).toBeUndefined();
  });

  it("treats false booleans as cleared", () => {
    const store = createNavStore({ mode: "architect", architect: { overlay: true } });
    store.getState().update({ architect: { overlay: false } });
    expect(store.getState().link.architect).toBeUndefined();
  });

  it("skips no-op updates (stable reference)", () => {
    const store = createNavStore({ mode: "code", code: { file: "a.ts" } });
    const before = store.getState().link;
    store.getState().update({ code: { file: "a.ts" } });
    expect(store.getState().link).toBe(before);
  });

  it("apply replaces the incoming subview's fields but keeps other modes' sections", () => {
    const store = createNavStore({
      mode: "architect",
      ws: "w1",
      architect: { diagram: "a.crystal" },
      threads: { thread: "r1" },
    });
    // infra owns the diagram selection — an infra URL without one clears it.
    store.getState().apply({ mode: "architect", ws: "w2", architect: { view: "infra" } });
    expect(store.getState().link).toEqual({
      mode: "architect",
      ws: "w2",
      architect: { view: "infra" },
      threads: { thread: "r1" },
    });
    // A bare "#/architect" (default view, nothing selected) empties the section.
    store.getState().apply({ mode: "architect" });
    expect(store.getState().link.architect).toBeUndefined();
    expect(store.getState().link.threads).toEqual({ thread: "r1" });
  });

  it("apply keeps sibling-subview state a URL cannot express", () => {
    const store = createNavStore({
      mode: "architect",
      architect: {
        view: "codebase",
        codemap: { kind: "module", ws: "w1", path: "packages/core" },
        system: "sys:auth",
      },
    });
    // Popping back onto an architecture URL clears its stale selections but
    // must not erase the code-map drill level (the URL never carried it).
    store.getState().apply({ mode: "architect", architect: { view: "architecture", focus: "sys:auth" } });
    expect(store.getState().link.architect).toEqual({
      view: "architecture",
      focus: "sys:auth",
      codemap: { kind: "module", ws: "w1", path: "packages/core" },
    });
  });
});
