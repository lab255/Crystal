import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrossInfraOverlay } from "@crystal/core";
import { InfraOverlayStore } from "./infra-overlay-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-infra-overlay-"));
  roots.push(root);
  return root;
}

describe("InfraOverlayStore", () => {
  it("returns an unpersisted default", async () => {
    const root = await tempRoot();
    const changed = vi.fn();
    const store = new InfraOverlayStore(root, changed, () => "2026-01-01T00:00:00.000Z");
    expect(await store.get()).toEqual(createCrossInfraOverlay("2026-01-01T00:00:00.000Z"));
    await expect(fs.readdir(path.join(root, "infra-overlays"))).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it("stamps every save and announces after persistence", async () => {
    const root = await tempRoot();
    const observed: string[] = [];
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
    const store = new InfraOverlayStore(root, (overlay) => observed.push(overlay.updatedAt), () => times.shift()!);
    const first = createCrossInfraOverlay("2025-12-31T00:00:00.000Z");
    first.pins.a = { x: 1, y: 2 };
    await store.save(first);
    const second = { ...(await store.get()), pins: { b: { x: 3, y: 4 } } };
    const saved = await store.save(second);
    expect(saved.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(observed).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    expect(JSON.parse(await fs.readFile(path.join(root, "infra-overlays", "default.json"), "utf8"))).toEqual(saved);
  });

  it("rejects invalid overlays without announcing", async () => {
    const root = await tempRoot();
    const changed = vi.fn();
    const store = new InfraOverlayStore(root, changed);
    await expect(store.save({ ...createCrossInfraOverlay(), id: "wrong" } as never)).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
  });
});
