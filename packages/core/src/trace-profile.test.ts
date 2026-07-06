import { describe, expect, it } from "vitest";
import type { CodeTrace } from "./codemap.js";
import { parseCrystalFile, serializeCrystalFile } from "./serialization.js";
import {
  TRACE_PROFILE_SCHEMA_VERSION,
  TraceProfileSchema,
  TraceProfileVersionError,
  buildFlameTree,
  flameTreeFromCodeTrace,
  migrateTraceProfileData,
  type TraceProfile,
} from "./trace-profile.js";

const profile: TraceProfile = TraceProfileSchema.parse({
  schemaVersion: TRACE_PROFILE_SCHEMA_VERSION,
  name: "checkout",
  unit: "milliseconds",
  spans: [
    { id: "root", name: "handleCheckout", file: "src/api.ts", symbol: "handleCheckout", value: 100 },
    { id: "svc", parentId: "root", name: "priceOrder", value: 60, calls: 3 },
    { id: "db", parentId: "svc", name: "query", value: 45 },
    { id: "log", parentId: "root", name: "audit", value: 10 },
  ],
});

describe("trace profile", () => {
  it("round-trips through the crystal envelope", () => {
    const parsed = parseCrystalFile("trace", serializeCrystalFile("trace", profile));
    expect(parsed).toEqual(profile);
  });

  it("rejects newer versions and missing schemaVersion", () => {
    expect(() => migrateTraceProfileData({})).toThrow(TraceProfileVersionError);
    expect(() =>
      migrateTraceProfileData({ schemaVersion: TRACE_PROFILE_SCHEMA_VERSION + 1 }),
    ).toThrow(/newer/);
  });

  it("tolerates unknown units from newer writers", () => {
    const parsed = TraceProfileSchema.parse({
      schemaVersion: 1,
      name: "x",
      unit: "picoseconds",
      spans: [],
    });
    expect(parsed.unit).toBe("samples");
  });
});

describe("buildFlameTree", () => {
  it("nests spans and derives self time", () => {
    const roots = buildFlameTree(profile);
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.name).toBe("handleCheckout");
    expect(root.total).toBe(100);
    expect(root.self).toBe(30); // 100 - 60 - 10
    expect(root.children.map((c) => c.name)).toEqual(["priceOrder", "audit"]);
    const svc = root.children[0]!;
    expect(svc.self).toBe(15); // 60 - 45
    expect(svc.calls).toBe(3);
    expect(svc.children[0]!.depth).toBe(2);
  });

  it("drops spans with broken or cyclic parent chains", () => {
    const bad = TraceProfileSchema.parse({
      schemaVersion: 1,
      name: "bad",
      spans: [
        { id: "ok", name: "ok", value: 5 },
        { id: "orphan", parentId: "ghost", name: "orphan", value: 1 },
        { id: "a", parentId: "b", name: "a", value: 1 },
        { id: "b", parentId: "a", name: "b", value: 1 },
      ],
    });
    const roots = buildFlameTree(bad);
    expect(roots.map((r) => r.name)).toEqual(["ok"]);
  });
});

describe("flameTreeFromCodeTrace", () => {
  const ref = (file: string, symbol: string) => ({ file, symbol });
  const trace: CodeTrace = {
    entry: ref("a.ts", "controller"),
    steps: [
      { ref: ref("a.ts", "controller"), module: "app", line: 1, depth: 0 },
      { ref: ref("b.ts", "service"), module: "app", line: 1, depth: 1 },
      { ref: ref("c.ts", "repo"), module: "app", line: 1, depth: 2 },
      { ref: ref("d.ts", "helper"), module: "app", line: 1, depth: 1 },
    ],
    edges: [
      { from: ref("a.ts", "controller"), to: ref("b.ts", "service") },
      { from: ref("a.ts", "controller"), to: ref("d.ts", "helper") },
      { from: ref("b.ts", "service"), to: ref("c.ts", "repo") },
      // cross-link: repo also called from helper; first parent wins
      { from: ref("d.ts", "helper"), to: ref("c.ts", "repo") },
      // cycle back to the entry must not recurse
      { from: ref("c.ts", "repo"), to: ref("a.ts", "controller") },
    ],
    truncated: false,
    unresolvedCalls: [],
  };

  it("builds a weighted tree from the BFS trace", () => {
    const root = flameTreeFromCodeTrace(trace)!;
    expect(root.name).toBe("controller");
    expect(root.total).toBe(4);
    expect(root.children.map((c) => c.name)).toEqual(["service", "helper"]);
    const service = root.children[0]!;
    expect(service.total).toBe(2);
    expect(service.children[0]!.name).toBe("repo");
  });

  it("returns null for an empty trace", () => {
    expect(
      flameTreeFromCodeTrace({ ...trace, steps: [], edges: [] }),
    ).toBeNull();
  });
});
