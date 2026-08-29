import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

describe("route samples persistence", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-samples-"));
  });
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it("round-trips, drops empty values and forgets routes with none left", async () => {
    const store = new WorkspaceStore(root);
    expect(await store.loadRouteSamples()).toEqual({});
    expect(await store.setRouteSamples("/invite/:token", { token: "abc" })).toEqual({
      "/invite/:token": { token: "abc" },
    });
    await store.setRouteSamples("/a/:x/:y", { x: "1", y: "" });
    expect(await store.loadRouteSamples()).toEqual({
      "/invite/:token": { token: "abc" },
      "/a/:x/:y": { x: "1" },
    });
    expect(await store.setRouteSamples("/invite/:token", { token: "" })).toEqual({
      "/a/:x/:y": { x: "1" },
    });
    const raw = JSON.parse(await fs.readFile(path.join(root, ".crystal/surfaces.json"), "utf8"));
    expect(raw).toEqual({ routes: { "/a/:x/:y": { x: "1" } } });
  });

  it("treats a corrupt file as no samples", async () => {
    await fs.writeFile(path.join(root, ".crystal/surfaces.json"), "{nope", "utf8");
    expect(await new WorkspaceStore(root).loadRouteSamples()).toEqual({});
  });
});
