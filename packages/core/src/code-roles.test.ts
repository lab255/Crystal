import { describe, expect, it } from "vitest";
import { moduleFlavorOf, roleOfFile, roleRank } from "./code-roles.js";

describe("moduleFlavorOf", () => {
  it("reads a React module as frontend", () => {
    expect(
      moduleFlavorOf(["components/BookingCard.tsx", "pages/Home.tsx", "api/client.ts"]),
    ).toBe("frontend");
  });

  it("reads a plain TS module as backend", () => {
    expect(moduleFlavorOf(["routes.ts", "handlers/booking.ts", "db/client.ts"])).toBe("backend");
  });

  it("ignores a stray tsx file in a large backend module", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "email.tsx"];
    expect(moduleFlavorOf(paths)).toBe("backend");
  });
});

describe("roleOfFile — backend", () => {
  it.each([
    ["routes.ts", "entry"],
    ["handlers/booking.ts", "entry"],
    ["middleware/auth.ts", "entry"],
    ["server.ts", "entry"],
    ["services/pricing.ts", "service"],
    ["processors/payment.ts", "service"],
    ["dispatcher.ts", "service"],
    ["bookings.repo.ts", "data"],
    ["db/client.ts", "data"],
    ["migrations.ts", "data"],
    ["queue/publisher.ts", "data"],
    ["types.ts", "other"],
  ] as const)("%s → %s", (path, role) => {
    expect(roleOfFile(path, "backend")).toBe(role);
  });

  it("prefers the basename over the directory", () => {
    // A repo file living under handlers/ is still a repo.
    expect(roleOfFile("handlers/session.repo.ts", "backend")).toBe("data");
  });
});

describe("roleOfFile — frontend", () => {
  it.each([
    ["providers/AuthProvider.tsx", "provider"],
    ["state/booking-store.ts", "provider"],
    ["layouts/Shell.tsx", "layout"],
    ["pages/Home.tsx", "layout"],
    ["router.tsx", "layout"],
    ["components/BookingCard.tsx", "component"],
    ["hooks/useBookings.ts", "component"],
    ["api/client.ts", "query"],
    ["queries/bookings.ts", "query"],
    ["Misc.tsx", "component"],
    ["constants.ts", "other"],
  ] as const)("%s → %s", (path, role) => {
    expect(roleOfFile(path, "frontend")).toBe(role);
  });
});

describe("roleRank", () => {
  it("orders backend bands entry < service < data < other", () => {
    const ranks = ["entry", "service", "data", "other"].map((r) =>
      roleRank(r as never, "backend"),
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("orders frontend bands provider < layout < component < query", () => {
    expect(roleRank("provider", "frontend")).toBeLessThan(roleRank("layout", "frontend"));
    expect(roleRank("layout", "frontend")).toBeLessThan(roleRank("component", "frontend"));
    expect(roleRank("component", "frontend")).toBeLessThan(roleRank("query", "frontend"));
  });

  it("sinks roles from the other flavor to the bottom", () => {
    expect(roleRank("provider", "backend")).toBe(4);
  });
});
