import { describe, expect, it } from "vitest";
import type {
  ScreenApiCall,
  ScreenSurface,
  SurfacesReport,
  SystemEndpoint,
  SystemLink,
  SystemModule,
  SystemOverview,
} from "@crystal/core";
import { diffSystemMap } from "./diff.js";
import { screenNodeId, type SystemMapLayoutInput } from "./scene.js";

/* ---- fixture builders (minimal but type-complete) ---- */

const screen = (route: string, file: string, component?: string): ScreenSurface => ({
  id: `react-router:${route}`,
  route,
  file,
  ...(component ? { component } : {}),
  source: "react-router",
});

const endpoint = (method: string, path: string, file: string): SystemEndpoint => ({
  method,
  path,
  file,
});

const system = (
  id: string,
  name: string,
  layer: SystemModule["layer"],
  partPaths: string[],
  endpoints: SystemEndpoint[] = [],
  fileCount = 10,
): SystemModule => ({
  id,
  name,
  concept: null,
  role: layer === "frontend" ? "domain" : "domain",
  layer,
  parts: partPaths.map((p) => ({ path: p, pkg: ".", fileCount: 5 })),
  fileCount,
  intents: [],
  exports: [],
  exportedTotal: 0,
  externals: [],
  endpoints,
  components: [],
  componentCount: 0,
});

const overview = (systems: SystemModule[], links: SystemLink[] = []): SystemOverview => ({
  systems,
  links,
  fileTotal: 100,
  generatedAt: "t",
});

const report = (screens: ScreenSurface[], endpoints: SystemEndpoint[] = []): SurfacesReport => ({
  screens,
  components: [],
  stories: [],
  endpoints,
  schemas: [],
  demo: { appUrl: null, storybookUrl: null },
  generatedAt: "t",
});

const call = (screenId: string, method: string, path: string, epFile: string): ScreenApiCall => ({
  screen: screenId,
  method,
  path,
  file: "apps/web/src/hooks/api.ts",
  endpoint: { method, path, file: epFile },
});

const link = (source: string, target: string, weight: number): SystemLink => ({
  source,
  target,
  weight,
  symbols: [],
});

const input = (
  screens: ScreenSurface[],
  systems: SystemModule[],
  calls: ScreenApiCall[],
  links: SystemLink[] = [],
): SystemMapLayoutInput => ({
  report: report(screens),
  overview: overview(systems, links),
  calls,
});

/* ---- shared fixture pieces ---- */

const home = screen("/", "apps/web/src/Home.tsx", "Home");
const settings = screen("/settings/:tab", "apps/web/src/Settings.tsx", "Settings");
const authSys = system("sys:auth", "Auth", "backend", ["apps/api/src/auth"], [
  endpoint("POST", "/api/login", "apps/api/src/auth/routes.ts"),
]);
const bookingSys = system("sys:booking", "Booking", "backend", ["apps/api/src/booking"], [
  endpoint("GET", "/api/bookings", "apps/api/src/booking/routes.ts"),
]);

describe("diffSystemMap", () => {
  it("reports no changes for identical inputs", () => {
    const side = input([home], [authSys], [call(home.id, "POST", "/api/login", "apps/api/src/auth/routes.ts")]);
    const d = diffSystemMap(side, side);
    expect(d.total).toBe(0);
    expect(d.marks.node.size).toBe(0);
    expect(d.marks.edge.size).toBe(0);
    expect(d.merged.report.screens).toHaveLength(1);
  });

  it("marks added/removed screens and injects removed ghosts", () => {
    const base = input([home, settings], [authSys], []);
    const head = input([home, screen("/new", "apps/web/src/New.tsx")], [authSys], []);
    const d = diffSystemMap(base, head);
    expect(d.marks.node.get(screenNodeId("react-router:/new"))).toBe("added");
    expect(d.marks.node.get(screenNodeId(settings.id))).toBe("removed");
    // The ghost rides into the merged canvas so the red card can render.
    expect(d.merged.report.screens.map((s) => s.id)).toContain(settings.id);
    const sections = d.entries.map((e) => e.section);
    expect(sections).toContain("New screens");
    expect(sections).toContain("Removed screens");
  });

  it("marks a screen whose file moved as modified", () => {
    const moved = { ...home, file: "apps/web/src/pages/Home.tsx" };
    const d = diffSystemMap(input([home], [], []), input([moved], [], []));
    expect(d.marks.node.get(screenNodeId(home.id))).toBe("modified");
    expect(d.entries[0]!.detail).toContain("→");
  });

  it("diffs call flows: added, dropped (with ghost calls), and reweighted", () => {
    const loginCall = call(home.id, "POST", "/api/login", "apps/api/src/auth/routes.ts");
    const bookingCall = call(home.id, "GET", "/api/bookings", "apps/api/src/booking/routes.ts");
    const base = input([home], [authSys, bookingSys], [loginCall, bookingCall]);
    const head = input(
      [home],
      [authSys, bookingSys],
      [loginCall, loginCall, call(settings.id, "POST", "/api/login", "apps/api/src/auth/routes.ts")].concat([]),
    );
    // head also needs the settings screen for its call to count.
    head.report = report([home, settings]);
    const d = diffSystemMap(base, head);
    const authEdge = `call:${screenNodeId(home.id)}->sys:auth`;
    const bookingEdge = `call:${screenNodeId(home.id)}->sys:booking`;
    const settingsEdge = `call:${screenNodeId(settings.id)}->sys:auth`;
    expect(d.marks.edge.get(settingsEdge)).toBe("added");
    expect(d.marks.edge.get(bookingEdge)).toBe("removed");
    expect(d.marks.edge.get(authEdge)).toBe("modified"); // 1 → 2 calls
    // Ghost calls re-draw the dropped flow on the merged canvas.
    expect(
      d.merged.calls.filter((c) => c.screen === home.id && c.path === "/api/bookings"),
    ).toHaveLength(1);
  });

  it("marks endpoint rows and flags the owning system as modified", () => {
    const authV2 = {
      ...authSys,
      endpoints: [endpoint("POST", "/api/login", "apps/api/src/auth/routes.ts"), endpoint("POST", "/api/logout", "apps/api/src/auth/routes.ts")],
    };
    const d = diffSystemMap(input([], [authSys], []), input([], [authV2], []));
    expect(d.marks.ep.get("sys:auth|POST /api/logout")).toBe("added");
    expect(d.marks.node.get("sys:auth")).toBe("modified");
    // Removal in the other direction appends a ghost row to the merged card.
    const back = diffSystemMap(input([], [authV2], []), input([], [authSys], []));
    expect(back.marks.ep.get("sys:auth|POST /api/logout")).toBe("removed");
    const mergedAuth = back.merged.overview.systems.find((s) => s.id === "sys:auth")!;
    expect(mergedAuth.endpoints.map((e) => `${e.method} ${e.path}`)).toContain("POST /api/logout");
  });

  it("marks system links added/removed/reweighted under both link: and feapi: ids", () => {
    const base = input([], [authSys, bookingSys], [], [link("sys:auth", "sys:booking", 4)]);
    const head = input([], [authSys, bookingSys], [], [link("sys:auth", "sys:booking", 12)]);
    const d = diffSystemMap(base, head);
    expect(d.marks.edge.get("link:sys:auth->sys:booking")).toBe("modified");
    expect(d.marks.edge.get("feapi:sys:auth->sys:booking")).toBe("modified");
    const gone = diffSystemMap(base, input([], [authSys, bookingSys], [], []));
    expect(gone.marks.edge.get("link:sys:auth->sys:booking")).toBe("removed");
    // The dropped link ghosts back into the merged overview.
    expect(gone.merged.overview.links).toHaveLength(1);
  });

  it("marks added and removed systems with ghosts", () => {
    const d = diffSystemMap(input([], [authSys], []), input([], [bookingSys], []));
    expect(d.marks.node.get("sys:booking")).toBe("added");
    expect(d.marks.node.get("sys:auth")).toBe("removed");
    expect(d.merged.overview.systems.map((s) => s.id).sort()).toEqual(["sys:auth", "sys:booking"]);
  });
});
