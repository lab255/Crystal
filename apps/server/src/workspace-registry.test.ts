import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseDirs } from "./browse.js";
import { packageNameOf, type CrossSurface } from "./code-map.js";
import { WorkspaceRegistry, computeCrossEdges } from "./workspace-registry.js";

function surface(partial: Partial<CrossSurface>): CrossSurface {
  return { packages: new Map(), externalImports: [], fileTotal: 0, ...partial };
}

describe("packageNameOf", () => {
  it("handles scoped, subpath and bare specifiers", () => {
    expect(packageNameOf("@crystal/core")).toBe("@crystal/core");
    expect(packageNameOf("@crystal/core/bridge")).toBe("@crystal/core");
    expect(packageNameOf("react")).toBe("react");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
  });

  it("rejects relative and node builtins", () => {
    expect(packageNameOf("./util.js")).toBeNull();
    expect(packageNameOf("../x")).toBeNull();
    expect(packageNameOf("node:path")).toBeNull();
  });
});

describe("computeCrossEdges", () => {
  it("matches one workspace's external imports against another's packages", () => {
    const surfaces = new Map<string, CrossSurface>([
      [
        "wsA",
        surface({
          externalImports: [
            { fromModule: "apps/web", pkg: "@lib/ui", names: ["Button"] },
            { fromModule: "apps/web", pkg: "@lib/ui", names: ["Dialog", "Button"] },
            { fromModule: "apps/api", pkg: "@lib/ui", names: ["theme"] },
            { fromModule: "apps/web", pkg: "react", names: ["default"] },
          ],
        }),
      ],
      ["wsB", surface({ packages: new Map([["@lib/ui", "packages/ui"]]) })],
    ]);

    const edges = computeCrossEdges(surfaces);
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge).toMatchObject({ source: "wsA", target: "wsB", weight: 3 });
    expect(edge.packages).toHaveLength(1);
    expect(edge.packages[0]).toMatchObject({ pkg: "@lib/ui", toModule: "packages/ui", count: 3 });
    // Heaviest consumer first, names deduplicated.
    expect(edge.packages[0]!.uses[0]).toEqual({
      fromModule: "apps/web",
      count: 2,
      names: ["Button", "Dialog"],
    });
    expect(edge.packages[0]!.uses[1]).toEqual({ fromModule: "apps/api", count: 1, names: ["theme"] });
  });

  it("produces directed edges per pair and ignores self-imports", () => {
    const surfaces = new Map<string, CrossSurface>([
      [
        "wsA",
        surface({
          packages: new Map([["@a/kit", "packages/kit"]]),
          externalImports: [
            { fromModule: "src", pkg: "@b/sdk", names: [] },
            // A workspace importing its own package is not a cross edge.
            { fromModule: "src", pkg: "@a/kit", names: [] },
          ],
        }),
      ],
      [
        "wsB",
        surface({
          packages: new Map([["@b/sdk", "."]]),
          externalImports: [{ fromModule: ".", pkg: "@a/kit", names: ["make"] }],
        }),
      ],
    ]);

    const edges = computeCrossEdges(surfaces);
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(["wsA->wsB", "wsB->wsA"]);
    expect(edges.every((e) => e.weight === 1)).toBe(true);
  });

  it("returns no edges for unrelated workspaces", () => {
    const surfaces = new Map<string, CrossSurface>([
      ["wsA", surface({ externalImports: [{ fromModule: ".", pkg: "lodash", names: [] }] })],
      ["wsB", surface({ packages: new Map([["@b/sdk", "."]]) })],
    ]);
    expect(computeCrossEdges(surfaces)).toEqual([]);
  });
});

describe("WorkspaceRegistry recents", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-registry-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("tracks opened workspaces most-recent-first, persists them, and flags gone dirs", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);
    const persistFile = path.join(tmp, "open-workspaces.json");

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    await registry.open(wsA);
    await registry.open(wsB);

    const recents = await registry.recents();
    expect(recents.map((r) => r.name)).toEqual(["beta", "alpha"]);
    expect(recents.every((r) => !r.missing)).toBe(true);

    const persisted = JSON.parse(await fs.readFile(persistFile, "utf8"));
    expect(persisted.roots).toHaveLength(2);
    // Stored oldest-first (map insertion order); served newest-first.
    expect(persisted.recents.map((r: { name: string }) => r.name)).toEqual(["alpha", "beta"]);
    registry.closeAll();

    // A fresh registry serves the reopen list without opening anything; a gone
    // directory is flagged missing rather than dropped.
    await fs.rm(wsB, { recursive: true });
    const registry2 = new WorkspaceRegistry(() => {}, persistFile);
    const recents2 = await registry2.recents();
    expect(recents2.map((r) => [r.name, r.missing ?? false])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
  });

  it("reads legacy persist files that predate recents", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    await fs.mkdir(wsA);
    const persistFile = path.join(tmp, "open-workspaces.json");
    await fs.writeFile(persistFile, JSON.stringify({ roots: [wsA] }), "utf8");

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    await registry.restorePersisted();
    expect(registry.list().map((w) => w.name)).toEqual(["alpha"]);
    // Restoring counts as opening — the reopen list picks it up.
    expect((await registry.recents()).map((r) => r.name)).toEqual(["alpha"]);
  });
});

describe("browseDirs", () => {
  it("lists sub-directories with workspace markers, skipping noise", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-browse-"));
    try {
      await fs.mkdir(path.join(tmp, "repo", ".git"), { recursive: true });
      await fs.mkdir(path.join(tmp, "crystal-ws", ".crystal"), { recursive: true });
      await fs.mkdir(path.join(tmp, "pkg"));
      await fs.writeFile(path.join(tmp, "pkg", "package.json"), "{}");
      await fs.mkdir(path.join(tmp, "plain"));
      await fs.mkdir(path.join(tmp, "node_modules"));
      await fs.mkdir(path.join(tmp, ".hidden"));
      await fs.writeFile(path.join(tmp, "file.txt"), "");

      const { path: listed, parent, entries } = await browseDirs(tmp);
      expect(listed).toBe(path.resolve(tmp));
      expect(parent).toBe(path.dirname(path.resolve(tmp)));
      expect(entries.map((e) => [e.name, e.marker ?? null])).toEqual([
        ["crystal-ws", "crystal"],
        ["pkg", "package"],
        ["plain", null],
        ["repo", "repo"],
      ]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
