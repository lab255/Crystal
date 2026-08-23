import { describe, expect, it } from "vitest";
import {
  COMPONENT_FILE_CAP,
  deriveC4Components,
  describeComponent,
} from "./c4-components.js";
import type { C4Model } from "./c4.js";
import type { CodeRole } from "./code-roles.js";
import type { SystemModule, SystemOverview } from "./system-overview.js";

const system = (over: Partial<SystemModule> & Pick<SystemModule, "id" | "name">): SystemModule => ({
  concept: null, role: "domain", layer: "backend", parts: [], fileCount: 10, intents: [], exports: [], exportedTotal: 0,
  externals: [], libraries: [], endpoints: [], components: [], componentCount: 0, ...over,
});
const overview = (systems: SystemModule[], links: SystemOverview["links"] = []): SystemOverview =>
  ({ systems, links, fileTotal: systems.reduce((n, s) => n + s.fileCount, 0), generatedAt: "" });

const model = (ids: string[]): C4Model => ({
  systemName: "Test", systemDescription: "", containers: [{ id: "ctr:app", name: "App", variant: "server", tech: [], memberSystemIds: ids, modulePath: "app", fileCount: 30, screenCount: 0 }],
  containerOfSystem: Object.fromEntries(ids.map((id) => [id, "ctr:app"])), containerOfModule: { app: "ctr:app" }, modules: [],
  categoryOfService: {}, nameOfService: {}, hasScreens: false,
});
const group = (role: CodeRole, count: number, stem: string = role) => ({ role, fileCount: count, files: Array.from({ length: count }, (_, i) => `app/${stem}/${i}.ts`) });
const fixture = (over: Partial<SystemModule> = {}) => system({
  id: "sys:booking", name: "Booking", fileCount: 15,
  groups: [group("entry", 5), group("service", 8), group("data", 2)],
  exports: [{ name: "createBooking", kind: "function", file: "app/service/0.ts", consumers: 5 }, { name: "route", kind: "function", file: "app/entry/0.ts", consumers: 2 }],
  libraries: [{ pkg: "fastify", weight: 4 }], endpoints: [{ method: "GET", path: "/bookings", file: "app/entry/0.ts" }],
  ...over,
});

describe("deriveC4Components", () => {
  it("splits substantial role groups and folds tiny groups into the primary", () => {
    const result = deriveC4Components({ model: model(["sys:booking"]), overview: overview([fixture()]) });
    const components = result.byContainer["ctr:app"]!;
    expect(components.map((c) => c.id)).toEqual(["cmp:app/booking.entry", "cmp:app/booking.service"]);
    expect(components.map((c) => c.name)).toEqual(["Booking api endpoints", "Booking service"]);
    const primary = components.find((c) => c.role === "service")!;
    expect(primary.fileCount).toBe(10);
    expect(primary.files).toContain("app/data/0.ts");
    expect(result.componentOfSystem["sys:booking"]).toBe(primary.id);
    expect(primary.interface.map((e) => e.name)).toEqual(["createBooking"]);
    expect(primary.description).toBe("Business logic · exposes createBooking · 10 files");
  });

  it("keeps small systems as one dominant-role component", () => {
    const small = fixture({ fileCount: 6, groups: [group("entry", 2), group("service", 4)] });
    const result = deriveC4Components({ model: model(["sys:booking"]), overview: overview([small]) });
    expect(result.byContainer["ctr:app"]!.map((c) => [c.id, c.role, c.fileCount])).toEqual([["cmp:app/booking", "service", 6]]);
    expect(Object.values(result.componentOfFile)).toEqual(Array(6).fill("cmp:app/booking"));
  });

  it("attributes and deduplicates role imports, with API edges on primaries", () => {
    const other = fixture({ id: "sys:users", name: "Users", groups: [group("entry", 4, "users-entry"), group("service", 8, "users-service")], groupLinks: [] });
    const booking = fixture({ groupLinks: [{ source: "entry", target: "service", weight: 2 }] });
    const result = deriveC4Components({ model: model(["sys:booking", "sys:users"]), overview: overview([booking, other], [
      { source: "sys:booking", target: "sys:users", weight: 3, symbols: ["findUser"], groups: [{ sourceGroup: "service", targetGroup: "service", weight: 3 }], apis: [{ method: "GET", path: "/users", weight: 2 }] },
      { source: "sys:booking", target: "sys:users", weight: 1, symbols: ["User"], groups: [{ sourceGroup: "service", targetGroup: "service", weight: 1 }] },
    ]) });
    expect(result.edges).toContainEqual({ source: "cmp:app/booking.entry", target: "cmp:app/booking.service", kind: "imports", weight: 2 });
    expect(result.edges).toContainEqual({ source: "cmp:app/booking.service", target: "cmp:app/users.service", kind: "imports", weight: 4, symbols: ["findUser", "User"] });
    expect(result.edges).toContainEqual({ source: "cmp:app/booking.service", target: "cmp:app/users.service", kind: "api", weight: 2 });
  });

  it("composes descriptions only from component facts", () => {
    const component = deriveC4Components({ model: model(["sys:booking"]), overview: overview([fixture()]) }).byContainer["ctr:app"]![0]!;
    expect(describeComponent({ ...component, role: "data", interface: [], entityCount: 2 })).toBe("Data access · 5 files · 2 entities");
    expect(describeComponent({ ...component, role: "entry", endpointCount: 0 })).toBe("Request surface · exposes route · 5 files");
    expect(describeComponent({ ...component, role: "layout", screenCount: 0 })).toBe("Screens · exposes route · 5 files");
    expect(describeComponent({ ...component, role: "component", fileCount: 0 })).toBe("UI components · exposes route · 0 files");
  });

  it("counts screen and schema inputs and reports capped member files", () => {
    const files = Array.from({ length: COMPONENT_FILE_CAP + 1 }, (_, i) => `app/pages/${i}.tsx`);
    const large = fixture({
      fileCount: files.length,
      groups: [{ role: "layout", fileCount: files.length, files }],
    });
    const result = deriveC4Components({
      model: model(["sys:booking"]),
      overview: overview([large]),
      screens: [
        { id: "next-app:/", route: "/", file: files[0]!, source: "next-app" },
        { id: "react-router:/two", route: "/two", file: "router.tsx", componentFile: files[1]!, source: "react-router" },
      ],
      schemas: [
        { id: `${files[2]}#View`, name: "View", file: files[2]!, line: 1, kind: "type", fields: [], usedBy: 0 },
      ],
    });
    const component = result.byContainer["ctr:app"]![0]!;
    expect(component).toMatchObject({
      screenCount: 2,
      entityCount: 1,
      filesTruncated: true,
      fileCount: COMPONENT_FILE_CAP + 1,
    });
    expect(component.files).toHaveLength(COMPONENT_FILE_CAP);
  });

  it("uses canonical system ids and suffixes colliding component slugs", () => {
    const systems = [
      fixture({ id: "sys:api", name: "API" }),
      fixture({ id: "sys:api-2", name: "API Foo", parts: [{ path: "foo", pkg: "app", fileCount: 15 }] }),
      fixture({ id: "sys:api-foo", name: "API Foo Literal" }),
    ];
    const ids = ["sys:api", "sys:api@foo", "sys:api-foo"];
    const result = deriveC4Components({ model: model(ids), overview: overview(systems) });
    expect(result.componentOfSystem).toMatchObject({
      "sys:api@foo": "cmp:app/api-foo.service",
      "sys:api-foo": "cmp:app/api-foo-2.service",
    });
  });
});
