import { describe, expect, it } from "vitest";
import type { SystemModule, SystemOverview } from "@crystal/core";
import {
  SYSTEM_CARD_EXPORTS_MAX,
  SYSTEM_CARD_W,
  buildSystemCardFacts,
  systemCardSlot,
} from "./system-card.js";

const system = (over: Partial<SystemModule> & { id: string; name: string }): SystemModule => ({
  concept: null,
  role: "domain",
  layer: "backend",
  parts: [{ path: over.id.replace(/^sys:/, ""), pkg: ".", fileCount: 4 }],
  fileCount: 4,
  intents: [],
  exports: [],
  exportedTotal: 0,
  externals: [],
  libraries: [],
  endpoints: [],
  components: [],
  componentCount: 0,
  ...over,
});

const overview = (systems: SystemModule[], links: SystemOverview["links"]): SystemOverview => ({
  systems,
  links,
  fileTotal: systems.reduce((n, s) => n + s.fileCount, 0),
  generatedAt: "2026-07-30T00:00:00.000Z",
});

describe("buildSystemCardFacts", () => {
  const auth = system({
    id: "sys:auth",
    name: "Authentication",
    exports: [
      { name: "createForm", kind: "function", file: "auth/form.ts", consumers: 12 },
      { name: "LoginBox", kind: "component", file: "auth/LoginBox.tsx", consumers: 7 },
      { name: "hash", kind: "function", file: "auth/hash.ts", consumers: 3 },
      { name: "verify", kind: "function", file: "auth/verify.ts", consumers: 2 },
      { name: "salt", kind: "const", file: "auth/hash.ts", consumers: 1 },
    ],
    exportedTotal: 40,
    externals: [{ id: "stripe", name: "Stripe", weight: 5 }],
    libraries: [{ pkg: "zod", weight: 9 }],
    endpoints: [
      { method: "POST", path: "/login", handler: "login", file: "auth/routes.ts" },
    ],
    componentCount: 2,
  });
  const forms = system({ id: "sys:forms", name: "Forms" });
  const ov = overview(
    [auth, forms],
    [{ source: "sys:auth", target: "sys:forms", weight: 6, symbols: ["buildSchema"] }],
  );

  it("joins facts by canonical id with exports capped at the card maximum", () => {
    const facts = buildSystemCardFacts(ov).get("sys:auth");
    expect(facts).toBeDefined();
    expect(facts!.exports).toHaveLength(SYSTEM_CARD_EXPORTS_MAX);
    expect(facts!.exports[0]).toEqual({ name: "createForm", consumers: 12, component: false });
    expect(facts!.exports[1]!.component).toBe(true);
    expect(facts!.exportsMore).toBe(1);
    expect(facts!.endpointCount).toBe(1);
  });

  it("lists consumed system names from outbound links", () => {
    const facts = buildSystemCardFacts(ov);
    expect(facts.get("sys:auth")!.consumes).toEqual(["Forms"]);
    expect(facts.get("sys:forms")!.consumes).toEqual([]);
    expect(facts.get("sys:auth")!.externals).toEqual(["Stripe"]);
    expect(facts.get("sys:auth")!.libraries).toEqual(["zod"]);
  });

  it("keys colliding ids by their canonical form", () => {
    const dup = system({
      id: "sys:auth-2",
      name: "Auth (server)",
      parts: [{ path: "apps/server/auth", pkg: "apps/server", fileCount: 4 }],
    });
    const facts = buildSystemCardFacts(overview([auth, dup], []));
    // The suffixed twin is re-keyed on its first part, matching the derived node id.
    expect(facts.has("sys:auth")).toBe(true);
    expect(facts.has("sys:auth-2")).toBe(false);
    expect([...facts.keys()].some((k) => k.startsWith("sys:auth@"))).toBe(true);
  });

  it("produces structured-clonable records (react-flow node data rule)", () => {
    const facts = buildSystemCardFacts(ov).get("sys:auth")!;
    expect(() => structuredClone(facts)).not.toThrow();
  });
});

describe("systemCardSlot", () => {
  it("grows with the sections the card will render", () => {
    const facts = buildSystemCardFacts(
      overview(
        [
          system({
            id: "sys:auth",
            name: "Authentication",
            exports: [
              { name: "a", kind: "function", file: "a.ts", consumers: 1 },
              { name: "b", kind: "function", file: "b.ts", consumers: 1 },
            ],
            libraries: [{ pkg: "zod", weight: 1 }],
          }),
          system({ id: "sys:bare", name: "Bare" }),
        ],
        [],
      ),
    );
    const rich = systemCardSlot(facts.get("sys:auth")!);
    const bare = systemCardSlot(facts.get("sys:bare")!);
    expect(rich.width).toBe(SYSTEM_CARD_W);
    expect(rich.height).toBeGreaterThan(bare.height);
  });
});
