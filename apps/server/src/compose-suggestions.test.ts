import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeSuggestions, discoverComposeFiles, pairComposePaths } from "./compose-suggestions.js";

const roots: string[] = [];
async function fixture(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-compose-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("compose suggestions", () => {
  it("discovers through depth two and prunes ignored and hidden directories", async () => {
    const root = await fixture();
    for (const rel of ["compose.yml", "a/compose.yaml", "a/b/docker-compose.yml", "a/b/c/compose.yml", "node_modules/x/compose.yml", ".hidden/compose.yml"]) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), "services: {}\n");
    }
    expect(await discoverComposeFiles(root)).toEqual(["a/b/docker-compose.yml", "a/compose.yaml", "compose.yml"]);
  });
  it("pairs overrides only with a same-directory base deterministically", () => {
    expect(pairComposePaths(["z/docker-compose.override.yml", "a/docker-compose.override.yaml", "a/compose.yml"])).toEqual(["a/compose.yml", "a/docker-compose.override.yaml"]);
  });
  it("skips directories whose readdir fails", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "compose.yml"), "services: {}\n");
    await fs.mkdir(path.join(root, "blocked"));
    const readdir = vi.fn(async (target: Parameters<typeof fs.readdir>[0], options: { withFileTypes: true }) => {
      if (String(target).endsWith(`${path.sep}blocked`)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return fs.readdir(target, options);
    }) as unknown as typeof fs.readdir;
    await expect(discoverComposeFiles(root, readdir)).resolves.toEqual(["compose.yml"]);
    expect(readdir).toHaveBeenCalledTimes(2);
  });
  it("reports oversized reads without losing other projects", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "compose.yml"), "services:\n  db:\n    image: postgres:16\n");
    await fs.mkdir(path.join(root, "large")); await fs.writeFile(path.join(root, "large/compose.yml"), "x".repeat(513 * 1024));
    const result = await composeSuggestions(root);
    expect(result.suggestions).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.path === "large/compose.yml")).toBe(true);
  });
});
