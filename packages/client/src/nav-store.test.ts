import { describe, expect, it } from "vitest";
import { createNavStore } from "./nav-store.js";

describe("nav store", () => {
  it("merges section patches field-by-field", () => {
    const store = createNavStore({ mode: "architect", architect: { view: "diagrams" } });
    store.getState().update({ architect: { diagram: "a.crystal" } });
    expect(store.getState().link.architect).toEqual({ view: "diagrams", diagram: "a.crystal" });
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

  it("apply replaces the incoming mode's section but keeps the others", () => {
    const store = createNavStore({
      mode: "architect",
      ws: "w1",
      architect: { diagram: "a.crystal" },
      orchestrate: { task: "t1" },
    });
    store.getState().apply({ mode: "architect", ws: "w2", architect: { view: "infra" } });
    expect(store.getState().link).toEqual({
      mode: "architect",
      ws: "w2",
      architect: { view: "infra" },
      orchestrate: { task: "t1" },
    });
    // A bare "#/architect" clears the stored architect section.
    store.getState().apply({ mode: "architect" });
    expect(store.getState().link.architect).toBeUndefined();
    expect(store.getState().link.orchestrate).toEqual({ task: "t1" });
  });
});
