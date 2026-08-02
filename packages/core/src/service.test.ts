import { describe, expect, it } from "vitest";
import {
  buildWatchFirePrompt,
  compileWatchPattern,
  createServiceDef,
  createWatchDef,
  ServicesFileSchema,
} from "./service.js";

describe("compileWatchPattern", () => {
  it("matches literal substrings case-insensitively", () => {
    const m = compileWatchPattern("ERROR")!;
    expect(m("2026-08-02 error: boom")).toBe(true);
    expect(m("all good")).toBe(false);
  });

  it("supports alternatives and anchors", () => {
    const m = compileWatchPattern("ERROR|^FATAL|denied$")!;
    expect(m("some ERROR here")).toBe(true);
    expect(m("FATAL: died")).toBe(true);
    expect(m("prefix FATAL")).toBe(false); // ^ anchor
    expect(m("access denied")).toBe(true);
    expect(m("denied access")).toBe(false); // $ anchor
  });

  it("treats regex metacharacters as literals — never as syntax", () => {
    const m = compileWatchPattern(".*")!;
    expect(m("anything")).toBe(false);
    expect(m("a .* literal")).toBe(true);
  });

  it("returns null for empty patterns (crash-only watches)", () => {
    expect(compileWatchPattern("")).toBeNull();
    expect(compileWatchPattern("  |  ")).toBeNull();
  });

  it("exact match with both anchors", () => {
    const m = compileWatchPattern("^ready$")!;
    expect(m("Ready")).toBe(true);
    expect(m("ready to serve")).toBe(false);
  });
});

describe("watch definitions", () => {
  it("createWatchDef defaults: crash-on, enabled, 5-minute throttle", () => {
    const w = createWatchDef({ serviceId: "svc_1", instructions: "fix it" });
    expect(w.onCrash).toBe(true);
    expect(w.enabled).toBe(true);
    expect(w.minIntervalSec).toBe(300);
    expect(w.pattern).toBe("");
  });

  it("schema rejects over-long patterns", () => {
    const w = createWatchDef({ serviceId: "s", instructions: "x" });
    expect(() =>
      ServicesFileSchema.parse({ services: [], watches: [{ ...w, pattern: "x".repeat(300) }] }),
    ).toThrow();
  });

  it("services file round-trips services + watches", () => {
    const svc = createServiceDef({ name: "dev", command: "pnpm dev" });
    const watch = createWatchDef({ serviceId: svc.id, pattern: "ERROR", instructions: "fix" });
    const parsed = ServicesFileSchema.parse({ services: [svc], watches: [watch] });
    expect(parsed.watches[0]!.serviceId).toBe(svc.id);
  });
});

describe("buildWatchFirePrompt", () => {
  it("frames a log fire with the matched line and instructions", () => {
    const prompt = buildWatchFirePrompt({
      serviceName: "web",
      command: "pnpm dev",
      reason: { kind: "log", line: "ERROR: connection refused" },
      instructions: "Diagnose and fix the connection error.",
      logTail: ["starting…", "ERROR: connection refused"],
    });
    expect(prompt).toContain("ERROR: connection refused");
    expect(prompt).toContain("Diagnose and fix");
    expect(prompt).toContain("automated wake");
  });

  it("frames a crash fire", () => {
    const prompt = buildWatchFirePrompt({
      serviceName: "web",
      command: "pnpm dev",
      reason: { kind: "crash", detail: "Exited with code 137" },
      instructions: "Bring it back.",
      logTail: [],
    });
    expect(prompt).toContain("it crashed: Exited with code 137");
  });
});
