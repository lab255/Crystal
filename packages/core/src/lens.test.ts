import { describe, expect, it } from "vitest";
import {
  buildLensMatcher,
  createWorkspaceFacet,
  inferFacetIntentTags,
  formatLensParam,
  lensLabel,
  parseLensParam,
  systemsInLens,
  WorkspaceFacetSchema,
  type LensSpec,
} from "./lens.js";

describe("lens param codec", () => {
  it("round-trips every spec kind", () => {
    const specs: LensSpec[] = [
      { kind: "tags", tags: ["intent:auth", "sys:forms"] },
      { kind: "facet", id: "facet_abc" },
      { kind: "diff", scope: "worktree" },
      { kind: "diff", scope: "base" },
      { kind: "diff", scope: { ref: "origin/main" } },
    ];
    for (const spec of specs) {
      expect(parseLensParam(formatLensParam(spec))).toEqual(spec);
    }
  });

  it("parses the historical bare-tags grammar", () => {
    expect(parseLensParam("intent:auth, intent:session")).toEqual({
      kind: "tags",
      tags: ["intent:auth", "intent:session"],
    });
  });

  it("yields null on empty or malformed input", () => {
    expect(parseLensParam(null)).toBeNull();
    expect(parseLensParam("")).toBeNull();
    expect(parseLensParam("  ")).toBeNull();
    expect(parseLensParam("diff:")).toBeNull();
    expect(parseLensParam("diff:ref:")).toBeNull();
    expect(parseLensParam("facet:")).toBeNull();
  });

  it("keeps refs with slashes intact", () => {
    const spec = parseLensParam("diff:ref:feature/scheduled-publish");
    expect(spec).toEqual({ kind: "diff", scope: { ref: "feature/scheduled-publish" } });
  });
});

describe("inferFacetIntentTags", () => {
  it("resolves lexicon display names and values", () => {
    expect(inferFacetIntentTags("Authentication")).toEqual(["intent:auth"]);
    expect(inferFacetIntentTags("auth")).toEqual(["intent:auth"]);
  });

  it("falls back to a name-derived slug", () => {
    expect(inferFacetIntentTags("General Ledger")).toEqual(["intent:general-ledger"]);
  });
});

describe("workspace facets", () => {
  it("creates a facet with a stable shape", () => {
    const facet = createWorkspaceFacet("Auth", { kind: "tags", tags: ["intent:auth"] });
    expect(WorkspaceFacetSchema.parse(facet)).toEqual(facet);
    expect(facet.name).toBe("Auth");
  });

  it("refuses facet-of-facet specs", () => {
    expect(() => createWorkspaceFacet("meta", { kind: "facet", id: "x" })).toThrow();
    expect(
      WorkspaceFacetSchema.safeParse({
        id: "f1",
        name: "meta",
        description: "",
        spec: { kind: "facet", id: "x" },
      }).success,
    ).toBe(false);
  });

  it("labels every kind", () => {
    const facets = [createWorkspaceFacet("Payments", { kind: "tags", tags: ["intent:pay"] })];
    expect(lensLabel({ kind: "facet", id: facets[0]!.id }, facets)).toBe("Payments");
    expect(lensLabel({ kind: "facet", id: "missing" }, facets)).toBe("Saved facet");
    expect(lensLabel({ kind: "diff", scope: "worktree" })).toBe("Working tree changes");
    expect(lensLabel({ kind: "diff", scope: { ref: "v1.2" } })).toBe("Diff vs v1.2");
    expect(lensLabel({ kind: "tags", tags: ["intent:auth"] })).toBe("intent:auth");
  });
});

describe("buildLensMatcher", () => {
  it("matches member files and files under member dirs", () => {
    const m = buildLensMatcher({
      files: ["src/auth/login.ts"],
      dirs: ["packages/forms"],
    });
    expect(m.empty).toBe(false);
    expect(m.file("src/auth/login.ts")).toBe(true);
    expect(m.file("packages/forms/src/api.ts")).toBe(true);
    expect(m.file("packages/formsg/src/api.ts")).toBe(false);
    expect(m.file("src/other.ts")).toBe(false);
  });

  it("under() sees files inside the dir and overlapping member dirs", () => {
    const m = buildLensMatcher({ files: ["src/auth/login.ts"], dirs: ["packages/forms"] });
    expect(m.under("src/auth")).toBe(true);
    expect(m.under("src")).toBe(true);
    expect(m.under("packages/forms/src")).toBe(true);
    expect(m.under("packages")).toBe(true);
    expect(m.under("apps/server")).toBe(false);
  });

  it("an empty membership matches nothing", () => {
    const m = buildLensMatcher({ files: [], dirs: [] });
    expect(m.empty).toBe(true);
    expect(m.file("anything.ts")).toBe(false);
    expect(buildLensMatcher(null).empty).toBe(true);
  });
});

describe("systemsInLens", () => {
  it("keeps systems whose parts contain members", () => {
    const matcher = buildLensMatcher({ files: ["packages/auth/src/login.ts"], dirs: [] });
    const systems = [
      { id: "sys:auth", parts: [{ path: "packages/auth" }] },
      { id: "sys:forms", parts: [{ path: "packages/forms" }] },
    ];
    expect([...systemsInLens(systems, matcher)]).toEqual(["sys:auth"]);
  });

  it("is empty for an empty lens", () => {
    const systems = [{ id: "sys:auth", parts: [{ path: "packages/auth" }] }];
    expect(systemsInLens(systems, buildLensMatcher(null)).size).toBe(0);
  });
});
