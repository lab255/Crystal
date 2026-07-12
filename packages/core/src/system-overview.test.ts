import { describe, expect, it } from "vitest";
import { buildCodeIndex, type IndexSourceFile } from "./code-index.js";
import {
  buildSystemOverview,
  npmPackageOf,
  type OverviewSourceFile,
  type SystemModule,
} from "./system-overview.js";

/** Shorthand source file: exports become functions unless named like a type. */
function src(
  path: string,
  pkg: string,
  opts: {
    exports?: string[];
    imports?: { from?: string; names?: string[]; external?: string }[];
    test?: boolean;
  } = {},
): OverviewSourceFile {
  return {
    path,
    pkg,
    test: opts.test,
    exports: (opts.exports ?? []).map((name) => ({ name, kind: "function" as const })),
    imports: (opts.imports ?? []).map((i) => ({
      specifier: i.external ?? `./${i.from}`,
      resolved: i.external ? null : (i.from ?? null),
      names: i.names ?? [],
    })),
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

  it("is deterministic", () => {
    const a = buildSystemOverview(formsgLikeSources());
    const b = buildSystemOverview([...formsgLikeSources()].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
