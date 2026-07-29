import { describe, expect, it } from "vitest";
import {
  MAX_DENIAL_RECORDS,
  denialsForWorkflow,
  emptyGrantsLedger,
  isPermissionDenial,
  recordDenial,
  setGrantedTools,
} from "./grants.js";

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
