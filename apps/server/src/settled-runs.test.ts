import { describe, expect, it } from "vitest";
import { createAgentRun } from "@crystal/core";
import { SettledRuns } from "./settled-runs.js";

/** A run in a given state; only id and status matter here. */
const run = (id: string, status: "running" | "completed" | "failed" | "cancelled") =>
  ({ ...createAgentRun({ prompt: "x" }), id, status });

describe("SettledRuns", () => {
  it("claims a settled run exactly once", () => {
    const settled = new SettledRuns();
    // Lifecycle adapters may surface the same terminal run more than once.
    expect(settled.claim(run("run_1", "completed"))).toBe(true);
    expect(settled.claim(run("run_1", "completed"))).toBe(false);
    expect(settled.claim(run("run_1", "failed"))).toBe(false);
  });

  it("ignores runs that have not settled", () => {
    const settled = new SettledRuns();
    expect(settled.claim(run("run_1", "running"))).toBe(false);
    // …and still claims it once it does.
    expect(settled.claim(run("run_1", "completed"))).toBe(true);
  });

  it("treats every terminal status as settled", () => {
    const settled = new SettledRuns();
    expect(settled.claim(run("a", "completed"))).toBe(true);
    expect(settled.claim(run("b", "failed"))).toBe(true);
    expect(settled.claim(run("c", "cancelled"))).toBe(true);
    expect(SettledRuns.isTerminal(run("d", "running"))).toBe(false);
  });

  it("forgets oldest-first past its cap — a long-lived server must not leak", () => {
    const settled = new SettledRuns(2);
    settled.claim(run("a", "completed"));
    settled.claim(run("b", "completed"));
    settled.claim(run("c", "completed")); // evicts "a"
    // The evicted run would be claimed again; that is the accepted trade —
    // the alternative is remembering every run id for the process's life.
    expect(settled.claim(run("a", "completed"))).toBe(true);
    expect(settled.claim(run("c", "completed"))).toBe(false);
  });
});
