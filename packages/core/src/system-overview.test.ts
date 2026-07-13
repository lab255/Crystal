import { describe, expect, it } from "vitest";
import { buildCodeIndex, type IndexSourceFile } from "./code-index.js";
import {
  buildSystemOverview,
  npmPackageOf,
  routeSegments,
  routesMatch,
  type HttpEndpoint,
  type OverviewSourceFile,
  type SystemModule,
} from "./system-overview.js";

/** Shorthand source file: exports become functions unless named like a type. */
function src(
  path: string,
  pkg: string,
  opts: {
    exports?: (string | { name: string; signature?: string })[];
    imports?: { from?: string; names?: string[]; external?: string }[];
    test?: boolean;
    endpoints?: HttpEndpoint[];
    apiCalls?: HttpEndpoint[];
  } = {},
): OverviewSourceFile {
  return {
    path,
    pkg,
    test: opts.test,
    exports: (opts.exports ?? []).map((e) =>
      typeof e === "string"
        ? { name: e, kind: "function" as const }
        : { name: e.name, kind: "function" as const, signature: e.signature },
    ),
    imports: (opts.imports ?? []).map((i) => ({
      specifier: i.external ?? `./${i.from}`,
      resolved: i.external ? null : (i.from ?? null),
      names: i.names ?? [],
    })),
    endpoints: opts.endpoints,
    apiCalls: opts.apiCalls,
  };
}

const byName = (overview: { systems: SystemModule[] }, name: string): SystemModule => {
  const system = overview.systems.find((s) => s.name === name);
  if (!system) {
    throw new Error(`no system "${name}" in [${overview.systems.map((s) => s.name).join(", ")}]`);
  }
  return system;
};

/** A FormSG-shaped workspace: backend modules/, app services/, frontend features/. */
function formsgLikeSources(): OverviewSourceFile[] {
  const be = "apps/backend";
  const fe = "apps/frontend";
  const auth = (f: string) => `${be}/src/app/modules/auth/${f}`;
  const submission = (f: string) => `${be}/src/app/modules/submission/${f}`;
  const form = (f: string) => `${be}/src/app/modules/form/${f}`;
  const payments = (f: string) => `${be}/src/app/modules/payments/${f}`;
  const mail = (f: string) => `${be}/src/app/services/mail/${f}`;
  const login = (f: string) => `${fe}/src/features/login/${f}`;
  return [
    // auth module
    src(auth("auth.service.ts"), be, { exports: ["getFormAfterPermissionChecks", "validateEmailDomain"] }),
    src(auth("auth.controller.ts"), be, {
      imports: [{ from: auth("auth.service.ts"), names: ["validateEmailDomain"] }],
    }),
    // submission module (nested sub-dirs stay inside the unit)
    src(submission("submission.service.ts"), be, { exports: ["createSubmission"] }),
    src(submission("email-submission/email-submission.service.ts"), be, {
      exports: ["submitEmailForm"],
      imports: [
        { from: auth("auth.service.ts"), names: ["getFormAfterPermissionChecks"] },
        { from: mail("mail.service.ts"), names: ["sendSubmissionMail"] },
      ],
    }),
    src(submission("encrypt-submission/encrypt-submission.service.ts"), be, {
      imports: [
        { from: auth("auth.service.ts"), names: ["getFormAfterPermissionChecks"] },
        { from: form("form.service.ts"), names: ["getFormById"] },
      ],
    }),
    // form module
    src(form("form.service.ts"), be, { exports: ["getFormById"] }),
    src(form("form.controller.ts"), be, {
      imports: [{ from: auth("auth.service.ts"), names: ["getFormAfterPermissionChecks"] }],
    }),
    // payments module — domain logic; only one file touches stripe
    src(payments("stripe.service.ts"), be, {
      exports: ["createPaymentIntent"],
      imports: [{ external: "stripe" }],
    }),
    src(payments("payments.service.ts"), be, {
      exports: ["findPayment"],
      imports: [{ from: payments("stripe.service.ts"), names: ["createPaymentIntent"] }],
    }),
    src(payments("payments.controller.ts"), be, {
      imports: [{ from: payments("payments.service.ts"), names: ["findPayment"] }],
    }),
    // mail infra client — every file leans on nodemailer
    src(mail("mail.service.ts"), be, {
      exports: ["sendSubmissionMail"],
      imports: [{ external: "nodemailer" }],
    }),
    src(mail("mail.utils.ts"), be, { imports: [{ external: "nodemailer" }] }),
    // frontend login feature — merges into Authentication via the lexicon
    src(login("LoginPage.tsx"), fe, { exports: ["LoginPage"] }),
    src(login("LoginForm.tsx"), fe, {
      imports: [{ from: login("LoginPage.tsx"), names: ["LoginPage"] }],
    }),
    // tests never count
    src(submission("__tests__/submission.service.spec.ts"), be, {
      test: true,
      imports: [{ from: payments("payments.service.ts"), names: ["findPayment"] }],
    }),
  ];
}

describe("npmPackageOf", () => {
  it("extracts plain and scoped package names", () => {
    expect(npmPackageOf("stripe")).toBe("stripe");
    expect(npmPackageOf("@aws-sdk/client-s3/commands")).toBe("@aws-sdk/client-s3");
    expect(npmPackageOf("./local")).toBeNull();
    expect(npmPackageOf("node:fs")).toBeNull();
  });
});

describe("buildSystemOverview", () => {
  it("clusters collection-dir subtrees into logical systems", () => {
    const overview = buildSystemOverview(formsgLikeSources());
    const names = overview.systems.map((s) => s.name);
    expect(names).toContain("Authentication");
    expect(names).toContain("Submission");
    expect(names).toContain("Form");
    expect(names).toContain("Payments");
    // Nested sub-dirs (email-submission/…) stay inside the Submission system.
    expect(byName(overview, "Submission").fileCount).toBe(3);
  });

  it("merges name-asserted units across packages", () => {
    const overview = buildSystemOverview(formsgLikeSources());
    const auth = byName(overview, "Authentication");
    // Backend modules/auth + frontend features/login (login is an auth word).
    expect(auth.parts.length).toBe(2);
    expect(new Set(auth.parts.map((p) => p.pkg))).toEqual(
      new Set(["apps/backend", "apps/frontend"]),
    );
  });

  it("surfaces the consumed export surface, ranked by consumers", () => {
    const overview = buildSystemOverview(formsgLikeSources());
    const auth = byName(overview, "Authentication");
    expect(auth.exports[0]).toMatchObject({
      name: "getFormAfterPermissionChecks",
      consumers: 3,
    });
    // validateEmailDomain is only used inside auth — not part of the surface.
    expect(auth.exports.map((e) => e.name)).not.toContain("validateEmailDomain");
    // 2 backend auth exports + the login feature's LoginPage (merged part).
    expect(auth.exportedTotal).toBe(3);
  });

  it("links systems with weights and the symbols travelling the edge", () => {
    const overview = buildSystemOverview(formsgLikeSources());
    const submission = byName(overview, "Submission");
    const auth = byName(overview, "Authentication");
    const link = overview.links.find((l) => l.source === submission.id && l.target === auth.id);
    expect(link).toMatchObject({ weight: 2 });
    expect(link?.symbols).toContain("getFormAfterPermissionChecks");
    // Test files add no edges: payments has no inbound link from submission.
    const payments = byName(overview, "Payments");
    expect(
      overview.links.some((l) => l.source === submission.id && l.target === payments.id),
    ).toBe(false);
  });

  it("classifies integration units and aggregates external services", () => {
    const overview = buildSystemOverview(formsgLikeSources());
    const mail = byName(overview, "Notifications"); // mail asserts the notifications concept
    expect(mail.role).toBe("integration");
    expect(mail.externals[0]).toMatchObject({ id: "email", name: "Email" });
    // Payments talks to Stripe but is domain logic (1 of 3 files integrates).
    const payments = byName(overview, "Payments");
    expect(payments.role).toBe("domain");
    expect(payments.externals[0]).toMatchObject({ id: "stripe", name: "Stripe" });
  });

  it("degrades to one system per package when no structure exists", () => {
    const overview = buildSystemOverview([
      src("packages/core/src/model.ts", "packages/core", { exports: ["createModel"] }),
      src("packages/core/src/graph.ts", "packages/core", { exports: ["diffGraphs"] }),
      src("apps/web/src/main.tsx", "apps/web", {
        imports: [{ from: "packages/core/src/model.ts", names: ["createModel"] }],
      }),
      src("apps/web/src/App.tsx", "apps/web", { exports: ["App"] }),
    ]);
    expect(overview.systems.map((s) => s.name).sort()).toEqual(["Core", "Web"]);
    const core = byName(overview, "Core");
    expect(core.parts[0]?.path).toBe("packages/core");
  });

  it("folds intent tags from the code index into concepts and profiles", () => {
    // Two units named nothing lexicon-ish, but the index says both are payments.
    const sources = [
      src("services/billing-engine/src/invoice.ts", "services/billing-engine", {
        exports: ["createInvoice"],
      }),
      src("services/billing-engine/src/charge.ts", "services/billing-engine", {
        exports: ["chargeCard"],
      }),
    ];
    const indexSources: IndexSourceFile[] = sources.map((s) => ({
      path: s.path,
      module: s.pkg,
      hash: "h",
      importerModules: 0,
      symbols: s.exports.map((e, i) => ({
        name: e.name,
        kind: "function" as const,
        line: i + 1,
        exported: true,
      })),
    }));
    const overview = buildSystemOverview(sources, buildCodeIndex(indexSources));
    // "billing" is a payments lexicon word — name-asserted concept.
    const payments = byName(overview, "Payments");
    expect(payments.concept).toBe("payments");
    expect(payments.intents.map((i) => i.value)).toContain("payments");
  });

  it("keeps a small app whole instead of splitting out presentation dirs", () => {
    // 8-file React app: components/hooks/pages must fold into one system —
    // no fake "App imports its own pages" cycles.
    const web = "apps/web";
    const overview = buildSystemOverview([
      src(`${web}/src/App.tsx`, web, {
        imports: [{ from: `${web}/src/pages/Home.tsx`, names: ["HomePage"] }],
      }),
      src(`${web}/src/api.ts`, web, { exports: ["apiClient"] }),
      src(`${web}/src/pages/Home.tsx`, web, { exports: ["HomePage"] }),
      src(`${web}/src/pages/Booking.tsx`, web, { exports: ["BookingPage"] }),
      src(`${web}/src/components/Header.tsx`, web, { exports: ["Header"] }),
      src(`${web}/src/components/Card.tsx`, web, { exports: ["Card"] }),
      src(`${web}/src/hooks/useBooking.ts`, web, {
        imports: [{ from: `${web}/src/api.ts`, names: ["apiClient"] }],
      }),
      src(`${web}/src/hooks/useAvailability.ts`, web, { exports: ["useAvailability"] }),
    ]);
    expect(overview.systems.map((s) => s.name)).toEqual(["Web"]);
    expect(overview.links).toEqual([]);
  });

  it("splits presentation dirs out of packages large enough to warrant it", () => {
    const web = "apps/web";
    const files = [
      ...Array.from({ length: 28 }, (_, i) => src(`${web}/src/f${i}.ts`, web)),
      src(`${web}/src/components/Header.tsx`, web, { exports: ["Header"] }),
      src(`${web}/src/components/Card.tsx`, web, { exports: ["Card"] }),
    ];
    const overview = buildSystemOverview(files);
    expect(overview.systems.map((s) => s.name).sort()).toEqual(["Components", "Web"]);
  });

  it("keeps shared packages structural — tags never rename them to a concept", () => {
    // A shared/ package full of money helpers is still "Shared", not "Payments".
    const overview = buildSystemOverview([
      src("shared/money.ts", "shared", { exports: ["Money", "addMoney"] }),
      src("shared/invoice.ts", "shared", { exports: ["invoiceTotal"] }),
      src("server/src/app.ts", "server", {
        imports: [{ from: "shared/money.ts", names: ["Money"] }],
      }),
      src("server/src/billing.ts", "server", { exports: ["charge"] }),
    ]);
    const shared = overview.systems.find((s) => s.parts.some((p) => p.pkg === "shared"));
    expect(shared?.name).toBe("Shared");
    expect(shared?.concept).toBeNull();
    expect(shared?.role).toBe("shared");
  });

  it("names a flat root workspace after its package, roles persistence as data", () => {
    const overview = buildSystemOverview([
      { ...src("index.ts", ".", { exports: ["main"] }), pkgName: "driftwood" },
      { ...src("util.ts", "."), pkgName: "driftwood" },
      src("packages/db/src/client.ts", "packages/db", { exports: ["createDatabase"] }),
      src("packages/db/src/repos.ts", "packages/db", { exports: ["BookingsRepository"] }),
    ]);
    expect(overview.systems.map((s) => s.name).sort()).toEqual(["Driftwood", "Persistence"]);
    expect(overview.systems.find((s) => s.name === "Persistence")?.role).toBe("data");
  });

  it("quarantines fixture codebases from the host repo's systems", () => {
    const overview = buildSystemOverview([
      // Host repo core + an example's core with the same name.
      src("packages/core/src/model.ts", "packages/core", { exports: ["createModel"] }),
      src("packages/core/src/graph.ts", "packages/core", { exports: ["diffGraphs"] }),
      src("examples/demoapp/packages/core/src/booking.ts", "examples/demoapp/packages/core", {
        exports: ["createBooking"],
      }),
      src("examples/demoapp/packages/core/src/fare.ts", "examples/demoapp/packages/core", {
        exports: ["fareQuote"],
      }),
    ]);
    const names = overview.systems.map((s) => s.name).sort();
    expect(names).toEqual(["Core", "Core (demoapp)"]);
  });

  it("keeps design-system packages shared, never concept-renamed", () => {
    // "token" is an auth lexicon word — design tokens must not make the UI
    // package the Authentication system.
    const overview = buildSystemOverview([
      src("packages/ui/src/tokens.ts", "packages/ui", { exports: ["colorTokens", "spaceTokens"] }),
      src("packages/ui/src/Button.tsx", "packages/ui", { exports: ["Button"] }),
      src("apps/web/src/App.tsx", "apps/web", {
        imports: [{ from: "packages/ui/src/Button.tsx", names: ["Button"] }],
      }),
      src("apps/web/src/main.tsx", "apps/web", {}),
    ]);
    const ui = overview.systems.find((s) => s.parts.some((p) => p.pkg === "packages/ui"));
    expect(ui?.name).toBe("Ui");
    expect(ui?.role).toBe("shared");
  });

  it("is deterministic", () => {
    const a = buildSystemOverview(formsgLikeSources());
    const b = buildSystemOverview([...formsgLikeSources()].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("layers", () => {
  it("classifies frontend by UI-file share, database and integrations by role", () => {
    const overview = buildSystemOverview([
      // frontend: mostly .tsx
      src("apps/web/src/booking/BookingPage.tsx", "apps/web", { exports: ["BookingPage"] }),
      src("apps/web/src/booking/BookingList.tsx", "apps/web", {}),
      // backend: plain ts domain logic (name must not share a concept with the
      // frontend unit, or the two would fuse into one cross-package system)
      src("apps/api/src/matching/matching.service.ts", "apps/api", { exports: ["matchDriver"] }),
      src("apps/api/src/matching/matching.rules.ts", "apps/api", {}),
      // database: repository files importing a db client
      src("apps/api/src/store/booking.repo.ts", "apps/api", {
        exports: ["saveBooking"],
        imports: [{ external: "mongoose" }],
      }),
      src("apps/api/src/store/user.repo.ts", "apps/api", { imports: [{ external: "mongoose" }] }),
      // integrations: SaaS-heavy unit
      src("apps/api/src/webhooks/stripe.hook.ts", "apps/api", { imports: [{ external: "stripe" }] }),
      src("apps/api/src/webhooks/twilio.hook.ts", "apps/api", { imports: [{ external: "twilio" }] }),
    ]);
    const layerOf = (part: string): string | undefined =>
      overview.systems.find((s) => s.parts.some((p) => p.path.includes(part)))?.layer;
    expect(layerOf("web/src/booking")).toBe("frontend");
    expect(layerOf("api/src/matching")).toBe("backend");
    expect(layerOf("store")).toBe("database");
    expect(layerOf("webhooks")).toBe("integrations");
  });
});

describe("signatures and link details", () => {
  it("threads export signatures into consumed exports and link details", () => {
    const sig = "(id: string): Promise<Form>";
    const overview = buildSystemOverview([
      src("src/form/form.service.ts", ".", {
        exports: [{ name: "getFormById", signature: sig }],
      }),
      src("src/form/form.helpers.ts", ".", {}),
      src("src/submission/submit.ts", ".", {
        imports: [{ from: "src/form/form.service.ts", names: ["getFormById"] }],
      }),
      src("src/submission/validate.ts", ".", {}),
    ]);
    const form = overview.systems.find((s) => s.parts.some((p) => p.path === "src/form"))!;
    expect(form.exports[0]?.signature).toBe(sig);
    const link = overview.links.find((l) => l.target === form.id);
    expect(link?.details?.[0]).toMatchObject({
      name: "getFormById",
      count: 1,
      signature: sig,
      // Declaring file rides along — the contract inspector jumps to it.
      file: "src/form/form.service.ts",
    });
  });
});

describe("API links", () => {
  it("matches outgoing HTTP calls to served routes across systems", () => {
    const overview = buildSystemOverview([
      // server system: two files, one serving routes
      src("apps/api/src/routes/booking.routes.ts", "apps/api", {
        endpoints: [
          { method: "POST", path: "/api/bookings" },
          { method: "GET", path: "/api/bookings/:id" },
        ],
      }),
      src("apps/api/src/routes/health.routes.ts", "apps/api", {}),
      // client system: calls the server over the wire, no imports
      src("apps/web/src/booking/api.ts", "apps/web", {
        apiCalls: [
          { method: "POST", path: "/api/bookings" },
          { method: "GET", path: "/api/bookings/*" }, // template hole
          { method: "GET", path: "/api/unknown" }, // no matching route
        ],
      }),
      src("apps/web/src/booking/Booking.tsx", "apps/web", {}),
    ]);
    const web = overview.systems.find((s) => s.parts.some((p) => p.path.startsWith("apps/web")))!;
    const api = overview.systems.find((s) => s.parts.some((p) => p.path.startsWith("apps/api")))!;
    expect(api.endpoints.map((e) => e.path)).toContain("/api/bookings");
    const link = overview.links.find((l) => l.source === web.id && l.target === api.id);
    expect(link).toBeDefined();
    expect(link?.weight).toBe(0); // API-only edge, no imports
    expect(link?.apis?.map((a) => `${a.method} ${a.path}`).sort()).toEqual([
      "GET /api/bookings/:id",
      "POST /api/bookings",
    ]);
  });

  it("normalizes and matches route paths across param conventions", () => {
    expect(routeSegments("/api/users/:id")).toEqual(["api", "users", "*"]);
    expect(routeSegments("https://api.example.com/v1/users/{id}")).toEqual(["v1", "users", "*"]);
    expect(routeSegments("/api/users/*/posts")).toEqual(["api", "users", "*", "posts"]);
    expect(routesMatch(routeSegments("/api/users/42"), routeSegments("/api/users/:id"))).toBe(true);
    expect(routesMatch(routeSegments("/api/users/*"), routeSegments("/api/users/:id"))).toBe(true);
    expect(routesMatch(routeSegments("/api/users"), routeSegments("/api/users/:id"))).toBe(false);
  });
});

describe("part links", () => {
  it("attributes intra-system imports to part pairs when units fuse", () => {
    const overview = buildSystemOverview([
      src("apps/web/src/booking/list.ts", "apps/web", {
        imports: [{ from: "apps/api/src/booking/service.ts", names: ["listBookings"] }],
      }),
      src("apps/web/src/booking/detail.ts", "apps/web", {
        imports: [{ from: "apps/api/src/booking/service.ts", names: ["getBooking"] }],
      }),
      src("apps/api/src/booking/service.ts", "apps/api", {
        exports: ["listBookings", "getBooking"],
      }),
      src("apps/api/src/booking/model.ts", "apps/api", {}),
    ]);
    const booking = byName(overview, "Booking");
    expect(booking.parts.map((p) => p.path).sort()).toEqual([
      "apps/api/src/booking",
      "apps/web/src/booking",
    ]);
    expect(booking.partLinks).toEqual([
      { source: "apps/web/src/booking", target: "apps/api/src/booking", weight: 2 },
    ]);
  });

  it("attributes cross-system links to (source part, target part) pairs", () => {
    const overview = buildSystemOverview([
      src("apps/web/src/portal/home.ts", "apps/web", {
        imports: [{ from: "apps/api/src/matching/engine.ts", names: ["match"] }],
      }),
      src("apps/web/src/portal/results.ts", "apps/web", {
        imports: [{ from: "apps/api/src/matching/engine.ts", names: ["match"] }],
      }),
      src("apps/api/src/matching/engine.ts", "apps/api", { exports: ["match"] }),
      src("apps/api/src/matching/rules.ts", "apps/api", {}),
    ]);
    const portal = byName(overview, "Portal");
    const matching = byName(overview, "Matching");
    const link = overview.links.find((l) => l.source === portal.id && l.target === matching.id);
    expect(link?.parts).toEqual([
      { sourcePart: "apps/web/src/portal", targetPart: "apps/api/src/matching", weight: 2 },
    ]);
    // Single-part systems carry no intra-system links.
    expect(portal.partLinks).toBeUndefined();
  });
});
