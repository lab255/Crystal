import { describe, expect, it } from "vitest";
import {
  computeSystemInsights,
  diffSystemOverviews,
  type SystemOverviewDiff,
} from "./system-insights.js";
import type { SystemLink, SystemModule, SystemOverview, SystemRole } from "./system-overview.js";

function system(id: string, role: SystemRole = "domain", fileCount = 10): SystemModule {
  return {
    id: `sys:${id}`,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    concept: null,
    role,
    layer: "backend",
    parts: [{ path: id, pkg: ".", fileCount }],
    fileCount,
    intents: [],
    exports: [],
    exportedTotal: 0,
    externals: [],
    endpoints: [],
  };
}

function link(source: string, target: string, weight = 1, symbols: string[] = []): SystemLink {
  return { source: `sys:${source}`, target: `sys:${target}`, weight, symbols };
}

function overview(systems: SystemModule[], links: SystemLink[]): SystemOverview {
  return { systems, links, fileTotal: systems.reduce((n, s) => n + s.fileCount, 0), generatedAt: "" };
}

describe("computeSystemInsights", () => {
  it("finds dependency cycles via strongly connected components", () => {
    const o = overview(
      [system("a"), system("b"), system("c"), system("d")],
      [link("a", "b", 5), link("b", "c", 2), link("c", "a", 1), link("c", "d", 9)],
    );
    const insights = computeSystemInsights(o);
    expect(insights.cycles).toHaveLength(1);
    expect(insights.cycles[0]?.ids).toEqual(["sys:a", "sys:b", "sys:c"]);
    expect(insights.cycles[0]?.weight).toBe(8);
    expect(insights.cycles[0]?.edges).toHaveLength(3);
  });

  it("flags upward and entry-import layering violations", () => {
    const o = overview(
      [system("utils", "shared"), system("auth"), system("routes", "entry")],
      [link("utils", "auth", 4, ["getUser"]), link("auth", "routes", 2)],
    );
    const insights = computeSystemInsights(o);
    expect(insights.violations.map((v) => v.kind)).toEqual(["upward", "entry-import"]);
    expect(insights.violations[0]?.detail).toContain("Utils");
  });

  it("computes metrics, hubs and orphans", () => {
    const spokes = ["a", "b", "c", "d", "e", "f"];
    const o = overview(
      [system("hub"), ...spokes.map((s) => system(s)), system("island", "domain", 7)],
      spokes.map((s) => link(s, "hub", 2)),
    );
    const insights = computeSystemInsights(o);
    expect(insights.hubs.map((h) => h.id)).toEqual(["sys:hub"]);
    const hub = insights.metrics.find((m) => m.id === "sys:hub");
    expect(hub).toMatchObject({ fanIn: 6, fanOut: 0, inWeight: 12, instability: 0 });
    expect(insights.orphans.map((x) => x.id)).toEqual(["sys:island"]);
    expect(insights.total).toBe(0);
  });
});

describe("diffSystemOverviews", () => {
  const base = overview(
    [system("auth"), system("form", "domain", 20), system("legacy")],
    [link("form", "auth", 4, ["getUser"]), link("legacy", "auth", 2)],
  );
  const head = overview(
    [
      system("auth"),
      system("form", "domain", 30),
      { ...system("payments"), externals: [{ id: "stripe", name: "Stripe", weight: 3 }] },
    ],
    [link("form", "auth", 12, ["getUser", "requireAdmin"]), link("payments", "form", 3)],
  );
  const diff: SystemOverviewDiff = diffSystemOverviews(base, head);

  it("reports added/removed systems and resizes", () => {
    expect(diff.addedSystems.map((s) => s.id)).toEqual(["sys:payments"]);
    expect(diff.removedSystems.map((s) => s.id)).toEqual(["sys:legacy"]);
    expect(diff.resized).toEqual([
      { id: "sys:form", name: "Form", before: 20, after: 30 },
    ]);
  });

  it("reports link changes with resolved names", () => {
    expect(diff.addedLinks).toMatchObject([{ sourceName: "Payments", targetName: "Form" }]);
    expect(diff.removedLinks).toMatchObject([{ sourceName: "Legacy", targetName: "Auth" }]);
    expect(diff.reweighted).toMatchObject([{ before: 4, after: 12 }]);
  });

  it("reports external service changes and totals structure only", () => {
    expect(diff.addedExternals).toEqual([
      { system: "sys:payments", systemName: "Payments", name: "Stripe" },
    ]);
    expect(diff.removedExternals).toEqual([]);
    // 1 added + 1 removed system, 1 added + 1 removed link, 1 added external.
    expect(diff.total).toBe(5);
  });

  it("is empty when nothing changed", () => {
    const d = diffSystemOverviews(base, base);
    expect(d.total).toBe(0);
    expect(d.resized).toEqual([]);
    expect(d.reweighted).toEqual([]);
  });
});
