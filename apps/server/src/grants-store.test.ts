import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantsStore } from "./grants-store.js";

describe("GrantsStore", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-grants-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts empty, persists tool edits, and survives a reload", async () => {
    const store = new GrantsStore(dir);
    expect((await store.get()).allowedTools).toEqual([]);

    await store.setTools([" WebFetch ", "Bash(gh:*)", "WebFetch"]);
    expect(await store.allowedTools()).toEqual(["WebFetch", "Bash(gh:*)"]);

    // A fresh store over the same directory reads the persisted ledger.
    const reloaded = new GrantsStore(dir);
    expect(await reloaded.allowedTools()).toEqual(["WebFetch", "Bash(gh:*)"]);
  });

  it("folds denials and emits change events after the write lands", async () => {
    const store = new GrantsStore(dir);
    let events = 0;
    store.events.on("changed", () => {
      events += 1;
    });
    await store.noteDenial({ tool: "Bash", runId: "r1", workflowId: "wf_x" });
    await store.noteDenial({ tool: "Bash", runId: "r2", workflowId: "wf_x" });
    const ledger = await store.get();
    const denial = ledger.denials.find((d) => d.tool === "Bash" && d.workflowId === "wf_x");
    expect(denial?.count).toBe(2);
    expect(denial?.lastRunId).toBe("r2");
    expect(events).toBe(2);
  });

  it("a corrupt file degrades to an empty ledger instead of throwing", async () => {
    const corrupt = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-grants-bad-"));
    await fs.writeFile(path.join(corrupt, "grants.json"), "{not json", "utf8");
    const store = new GrantsStore(corrupt);
    expect((await store.get()).allowedTools).toEqual([]);
    await fs.rm(corrupt, { recursive: true, force: true });
  });
});
