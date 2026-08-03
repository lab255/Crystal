import { describe, expect, it } from "vitest";
import {
  MAX_DENIAL_RECORDS,
  denialsForWorkflow,
  emptyGrantsLedger,
  isPermissionDenial,
  matchesToolPattern,
  recordDenial,
  setGrantedTools,
  toolAllowedByPatterns,
} from "./grants.js";

describe("matchesToolPattern", () => {
  it("matches bare tool names exactly", () => {
    expect(matchesToolPattern("WebFetch", {}, "WebFetch")).toBe(true);
    expect(matchesToolPattern("WebSearch", {}, "WebFetch")).toBe(false);
    // A bare name never matches a mere prefix of another tool's name.
    expect(matchesToolPattern("WebFetcher", {}, "WebFetch")).toBe(false);
  });

  it("treats a bare MCP server name as a whole-server grant", () => {
    expect(matchesToolPattern("mcp__crystal__ask_question", {}, "mcp__crystal")).toBe(true);
    expect(matchesToolPattern("mcp__other__tool", {}, "mcp__crystal")).toBe(false);
  });

  it("matches Bash(prefix:*) as a command prefix", () => {
    const p = "Bash(git commit:*)";
    expect(matchesToolPattern("Bash", { command: "git commit -m x" }, p)).toBe(true);
    expect(matchesToolPattern("Bash", { command: "git commit" }, p)).toBe(true);
    expect(matchesToolPattern("Bash", { command: "git push" }, p)).toBe(false);
    expect(matchesToolPattern("WebFetch", { command: "git commit" }, p)).toBe(false);
  });

  it("matches glob-style specs (the dev-loop allowlist shapes)", () => {
    expect(matchesToolPattern("Bash", { command: "git status --short" }, "Bash(git status*)")).toBe(true);
    expect(matchesToolPattern("Bash", { command: "git add ." }, "Bash(git add *)")).toBe(true);
    expect(matchesToolPattern("Bash", { command: "git add" }, "Bash(git add *)")).toBe(false);
    expect(matchesToolPattern("Bash", { command: "rm -rf /" }, "Bash(git add *)")).toBe(false);
  });

  it("requires an exact argument match when the spec has no wildcard", () => {
    expect(matchesToolPattern("Bash", { command: "npm test" }, "Bash(npm test)")).toBe(true);
    expect(matchesToolPattern("Bash", { command: "npm test --watch" }, "Bash(npm test)")).toBe(false);
  });

  it("fails closed when the call has no recognizable string argument", () => {
    expect(matchesToolPattern("Bash", {}, "Bash(git status*)")).toBe(false);
    expect(matchesToolPattern("Bash", null, "Bash(*)")).toBe(false);
    // …but a bare-name grant still covers it.
    expect(matchesToolPattern("Bash", {}, "Bash")).toBe(true);
  });

  it("reads the primary argument from the common input keys", () => {
    expect(matchesToolPattern("Read", { file_path: "/etc/hosts" }, "Read(/etc/*)")).toBe(true);
    expect(matchesToolPattern("WebFetch", { url: "https://a.dev/x" }, "WebFetch(https://a.dev*)")).toBe(true);
  });

  it("never treats regex metacharacters in a spec as regex", () => {
    expect(matchesToolPattern("Bash", { command: "echo a.b" }, "Bash(echo a.b)")).toBe(true);
    expect(matchesToolPattern("Bash", { command: "echo aXb" }, "Bash(echo a.b)")).toBe(false);
  });
});

describe("toolAllowedByPatterns", () => {
  it("answers across a pattern list", () => {
    const patterns = ["mcp__crystal", "Bash(git status*)"];
    expect(toolAllowedByPatterns("mcp__crystal__board_status", {}, patterns)).toBe(true);
    expect(toolAllowedByPatterns("Bash", { command: "git status" }, patterns)).toBe(true);
    expect(toolAllowedByPatterns("Bash", { command: "git push" }, patterns)).toBe(false);
    expect(toolAllowedByPatterns("WebFetch", {}, [])).toBe(false);
  });
});

describe("recordDenial", () => {
  it("folds repeats per (tool, workflow) and keeps other keys separate", () => {
    let ledger = emptyGrantsLedger("t0");
    ledger = recordDenial(ledger, { tool: "Bash", runId: "r1", workflowId: "wf_a", at: "t1" });
    ledger = recordDenial(ledger, { tool: "Bash", runId: "r2", workflowId: "wf_a", at: "t2" });
    ledger = recordDenial(ledger, { tool: "Bash", runId: "r3", workflowId: "wf_b", at: "t3" });
    ledger = recordDenial(ledger, { tool: "WebFetch", runId: "r4", at: "t4" });

    expect(ledger.denials).toHaveLength(3);
    const bashA = ledger.denials.find((d) => d.tool === "Bash" && d.workflowId === "wf_a")!;
    expect(bashA.count).toBe(2);
    expect(bashA.firstAt).toBe("t1");
    expect(bashA.lastAt).toBe("t2");
    expect(bashA.lastRunId).toBe("r2");
    // No workflow attribution is its own bucket, not smeared into wf_a's.
    expect(ledger.denials.find((d) => d.tool === "WebFetch")?.workflowId).toBeNull();
  });

  it("bounds the record list by recency", () => {
    let ledger = emptyGrantsLedger("t0");
    for (let i = 0; i < MAX_DENIAL_RECORDS + 20; i += 1) {
      ledger = recordDenial(ledger, {
        tool: `tool-${i}`,
        runId: `r${i}`,
        at: `t${String(i).padStart(4, "0")}`,
      });
    }
    expect(ledger.denials).toHaveLength(MAX_DENIAL_RECORDS);
    // The oldest fell off; the newest survived.
    expect(ledger.denials.some((d) => d.tool === "tool-0")).toBe(false);
    expect(ledger.denials.some((d) => d.tool === `tool-${MAX_DENIAL_RECORDS + 19}`)).toBe(true);
  });

  it("denialsForWorkflow filters by attribution, newest first", () => {
    let ledger = emptyGrantsLedger("t0");
    ledger = recordDenial(ledger, { tool: "A", runId: "r1", workflowId: "wf", at: "t1" });
    ledger = recordDenial(ledger, { tool: "B", runId: "r2", workflowId: "wf", at: "t2" });
    ledger = recordDenial(ledger, { tool: "C", runId: "r3", at: "t3" });
    expect(denialsForWorkflow(ledger, "wf").map((d) => d.tool)).toEqual(["B", "A"]);
    expect(denialsForWorkflow(ledger, null).map((d) => d.tool)).toEqual(["C"]);
  });
});

describe("setGrantedTools", () => {
  it("trims, drops empties and de-duplicates while keeping order", () => {
    const ledger = setGrantedTools(
      emptyGrantsLedger("t0"),
      [" WebFetch ", "Bash(gh:*)", "", "WebFetch"],
      "t1",
    );
    expect(ledger.allowedTools).toEqual(["WebFetch", "Bash(gh:*)"]);
    expect(ledger.updatedAt).toBe("t1");
  });
});

describe("isPermissionDenial", () => {
  it("matches the CLI's denial phrasings", () => {
    expect(
      isPermissionDenial(
        "Claude requested permissions to use Bash, but you haven't granted it.",
      ),
    ).toBe(true);
    expect(isPermissionDenial("Permission to use WebFetch has been denied.")).toBe(true);
    expect(isPermissionDenial("The user doesn't want to proceed with this tool use.")).toBe(true);
  });

  it("does not fire on ordinary errors that mention permissions", () => {
    expect(isPermissionDenial("EACCES: permission denied, open '/etc/hosts'")).toBe(false);
    expect(isPermissionDenial("chmod: changing permissions of 'x': Operation not permitted")).toBe(
      false,
    );
  });
});
