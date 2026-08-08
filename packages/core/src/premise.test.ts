import { describe, expect, it } from "vitest";
import {
  hasAsserts,
  parseAsserts,
  premiseGapPromptNote,
  premiseGaps,
  premiseReportText,
  type PremiseReport,
} from "./premise.js";

describe("parseAsserts", () => {
  it("parses each assertion kind from brief lines", () => {
    const brief = [
      "Ship the release automation.",
      "assert: branch release/2.3",
      "  assert: ref abc1234",
      "assert: file scripts/release.mjs",
      "assert: tool gh",
      "assert: cmd gh pr view 204 --json state",
      "Not an assert: branch of work.",
    ].join("\n");
    const parsed = parseAsserts(brief);
    expect(parsed.map((a) => a.kind)).toEqual(["branch", "ref", "file", "tool", "cmd"]);
    expect(parsed[0]).toMatchObject({ kind: "branch", arg: "release/2.3" });
    // cmd keeps its whole tail — commands have spaces.
    expect(parsed[4]).toMatchObject({ kind: "cmd", arg: "gh pr view 204 --json state" });
    expect(hasAsserts(brief)).toBe(true);
    expect(hasAsserts("no claims here")).toBe(false);
  });

  it("keeps bare markers, unknown kinds and empty args as malformed claims", () => {
    const parsed = parseAsserts("assert:\nassert: pr 204 is green\nassert: branch");
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      kind: "malformed",
      arg: "",
      raw: "assert:",
      reason: "missing-kind",
    });
    expect(parsed[1]!.kind).toBe("malformed");
    expect(parsed[1]!.raw).toBe("assert: pr 204 is green");
    // A kind with no argument is malformed, not a held claim.
    expect(parsed[2]!.kind).toBe("malformed");
    expect(hasAsserts("assert:")).toBe(true);
  });

  it("is case-insensitive on the marker and kind", () => {
    const parsed = parseAsserts("ASSERT: Branch main");
    expect(parsed[0]).toMatchObject({ kind: "branch", arg: "main" });
  });
});

describe("premise report rendering", () => {
  const report: PremiseReport = {
    checkedAt: "2026-07-29T00:00:00.000Z",
    ok: false,
    checks: [
      { kind: "branch", arg: "main", raw: "assert: branch main", ok: true, detail: "local branch" },
      {
        kind: "ref",
        arg: "deadbeef",
        raw: "assert: ref deadbeef",
        ok: false,
        detail: "does not resolve in this repo",
      },
    ],
  };

  it("premiseGaps lists only the failed claims", () => {
    expect(premiseGaps(report).map((c) => c.arg)).toEqual(["deadbeef"]);
  });

  it("report text is loud about false claims and quiet about held ones", () => {
    const text = premiseReportText(report);
    expect(text).toContain("FAILED CLAIMS");
    expect(text).toContain("assert: branch main: holds (local branch)");
    expect(text).toContain("assert: ref deadbeef: FALSE — does not resolve in this repo");
  });

  it("prompt note exists only when something failed, and says what to do", () => {
    const note = premiseGapPromptNote(report);
    expect(note).toContain("FAILED PREMISES");
    expect(note).toContain("assert: ref deadbeef");
    expect(note).toContain("ask_question");
    expect(premiseGapPromptNote({ ...report, ok: true, checks: [report.checks[0]!] })).toBeNull();
    expect(premiseGapPromptNote(null)).toBeNull();
  });
});
