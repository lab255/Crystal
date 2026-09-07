import { describe, expect, it } from "vitest";
import { activeDeriveStage, deriveOverallFraction, deriveStages } from "./derive-progress.js";

const ws = "w";

describe("deriveStages", () => {
  it("starts at discover before any progress event", () => {
    const st = deriveStages({ progress: null, loading: true, hasData: false, overlay: false, rendered: false });
    expect(st.map((s) => s.status)).toEqual(["active", "pending", "pending", "pending", "pending"]);
  });
  it("fills parse by file count", () => {
    const st = deriveStages({
      progress: { ws, phase: "parsing", done: 25, total: 100 },
      loading: true, hasData: false, overlay: false, rendered: false,
    });
    expect(st[0]!.status).toBe("done");
    expect(st[1]!).toMatchObject({ status: "active", fraction: 0.25 });
    expect(deriveOverallFraction(st)).toBeCloseTo(0.2 + 0.05);
  });
  it("maps analyzer done + pending request to the derive stage", () => {
    expect(activeDeriveStage({
      progress: { ws, phase: "done", done: 5, total: 5 },
      loading: true, hasData: false, overlay: false, rendered: false,
    })).toBe("derive");
  });
  it("keeps layout active while waiting for the overlay", () => {
    const state = { progress: null, loading: false, hasData: true, overlay: false, rendered: false };
    expect(activeDeriveStage(state)).toBe("layout");
    const stages = deriveStages(state);
    expect(stages[4]).toMatchObject({ status: "active", fraction: null });
    expect(deriveOverallFraction(stages)).toBeCloseTo(0.8);
    const completed = deriveStages({ ...state, overlay: true, rendered: true });
    expect(completed.every((stage) => stage.status === "done")).toBe(true);
    expect(deriveOverallFraction(completed)).toBe(1);
  });
  it("data landed but not rendered is layout; rendered completes everything", () => {
    expect(activeDeriveStage({ progress: null, loading: false, hasData: true, overlay: true, rendered: false })).toBe("layout");
    const st = deriveStages({ progress: null, loading: false, hasData: true, overlay: true, rendered: true });
    expect(st.every((s) => s.status === "done")).toBe(true);
    expect(deriveOverallFraction(st)).toBe(1);
  });
});
