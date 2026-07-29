import { describe, expect, it } from "vitest";
import {
  envGapPromptNote,
  envGaps,
  envReportText,
  toolNeedsForMarkers,
  type EnvReport,
} from "./preflight.js";

function report(okIds: string[], missing: { id: string; label: string; reason: string }[]): EnvReport {
  return {
    checkedAt: "2026-07-29T00:00:00.000Z",
    ok: missing.length === 0,
    checks: [
      ...okIds.map((id) => ({
        id,
        label: id,
        bins: [id],
        reason: "always",
        ok: true,
        resolved: `/usr/bin/${id}`,
      })),
      ...missing.map((m) => ({ ...m, bins: [m.id], ok: false, resolved: null })),
    ],
  };
}

describe("pre-flight tool needs", () => {
  it("always expects git; markers add the rest", () => {
    expect(toolNeedsForMarkers([]).map((n) => n.id)).toEqual(["git"]);
    const ids = toolNeedsForMarkers(["package.json", "pnpm-lock.yaml", "Cargo.toml"]).map(
      (n) => n.id,
    );
    expect(ids).toEqual(["git", "node", "pnpm", "cargo"]);
  });

  it("the lockfile names the package manager; bare package.json means npm", () => {
    expect(toolNeedsForMarkers(["package.json", "yarn.lock"]).map((n) => n.id)).toContain("yarn");
    expect(toolNeedsForMarkers(["package.json"]).map((n) => n.id)).toContain("npm");
    expect(toolNeedsForMarkers(["package.json", "pnpm-lock.yaml"]).map((n) => n.id)).not.toContain(
      "npm",
    );
  });

  it("marker matching is case-insensitive (Cargo.toml, Gemfile)", () => {
    expect(toolNeedsForMarkers(["cargo.toml"]).map((n) => n.id)).toContain("cargo");
    expect(toolNeedsForMarkers(["Gemfile"]).map((n) => n.id)).toContain("ruby");
  });

  it("python needs try python3 then python", () => {
    const py = toolNeedsForMarkers(["pyproject.toml"]).find((n) => n.id === "python");
    expect(py?.bins).toEqual(["python3", "python"]);
  });
});

describe("pre-flight report rendering", () => {
  it("a clean report renders ok and injects nothing into the prompt", () => {
    const clean = report(["git", "node"], []);
    expect(envGaps(clean)).toHaveLength(0);
    expect(envReportText(clean)).toContain("(ok)");
    expect(envGapPromptNote(clean)).toBeNull();
    expect(envGapPromptNote(null)).toBeNull();
  });

  it("gaps are loud in both the report text and the prompt note", () => {
    const broken = report(["git"], [{ id: "pnpm", label: "pnpm", reason: "pnpm-lock.yaml" }]);
    expect(envReportText(broken)).toContain("pnpm: MISSING — expected because pnpm-lock.yaml");
    const note = envGapPromptNote(broken)!;
    expect(note).toContain("ENVIRONMENT GAPS");
    expect(note).toContain("pnpm (expected because pnpm-lock.yaml)");
    // The note tells the manager what to do, not just what's broken.
    expect(note).toContain("ask_question");
  });
});
