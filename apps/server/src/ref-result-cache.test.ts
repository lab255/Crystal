import { beforeEach, expect, it, vi } from "vitest";
import { RefResultCache } from "./ref-result-cache.js";
import type { JobQueue } from "./job-queue.js";

const inputs = vi.hoisted(() => ({ commit: "abc", config: "{}" }));
vi.mock("./git.js", () => ({ gitResolveRef: vi.fn(async () => inputs.commit) }));
vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn(async () => inputs.config) } }));
beforeEach(() => { inputs.commit = "abc"; inputs.config = "{}"; });

it("caches by resolved commit, shape, repo, root and config, evicting after four results", async () => {
  const run = vi.fn(async () => ({ commit: inputs.commit, sources: [] }));
  const cache = new RefResultCache({ run } as unknown as JobQueue);
  const get = (ref = "HEAD", root = "/repo", repo = ".") => cache.get("refOverviewSources", root, repo, ref);
  const first = await get();
  expect(await get("main")).toBe(first);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toEqual([
    "refOverviewSources", ["/repo", ".", "abc"],
    expect.objectContaining({ timeoutMs: 600_000 }),
  ]);
  await cache.get("refSurfacesSnapshot", "/repo", ".", "HEAD");
  await get("HEAD", "/other");
  await get("HEAD", "/repo", "nested");
  inputs.config = '{"exclude":["vendor"]}';
  await get();
  expect(run).toHaveBeenCalledTimes(5);
  inputs.config = "{}";
  expect(await get()).not.toBe(first);
  inputs.commit = "def";
  expect((await get()).commit).toBe("def");
  expect(run).toHaveBeenCalledTimes(7);
});

it("does not retain failures and rejects after disposal", async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({ commit: "abc", sources: [] });
  const cache = new RefResultCache({ run } as unknown as JobQueue);
  await expect(cache.get("refOverviewSources", "/repo", ".", "HEAD")).rejects.toThrow("failed");
  await expect(cache.get("refOverviewSources", "/repo", ".", "HEAD")).resolves.toHaveProperty("commit", "abc");
  expect(run).toHaveBeenCalledTimes(2);
  cache.dispose();
  await expect(cache.get("refOverviewSources", "/repo", ".", "HEAD")).rejects.toThrow("disposed");
});
