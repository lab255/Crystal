import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseDirs } from "./browse.js";
import { packageNameOf, type CrossSurface } from "./code-map.js";
import type { TerminalSeed } from "./terminal-manager.js";
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
    await registry.closeAll();

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

describe("WorkspaceRegistry per-flavor persistence", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-flavor-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("keeps each flavor's open set in its own file while recents stay shared", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);
    const shared = path.join(tmp, "open-workspaces.json");

    const regA = new WorkspaceRegistry(() => {}, shared, null, "flav-a");
    const regB = new WorkspaceRegistry(() => {}, shared, null, "flav-b");
    cleanups.push(() => regA.closeAll());
    cleanups.push(() => regB.closeAll());
    await regA.open(wsA);
    await regB.open(wsB);

    // Each flavor owns its file — B persisting did not clobber A's open set.
    const fileA = JSON.parse(await fs.readFile(path.join(tmp, "open-workspaces.flav-a.json"), "utf8"));
    const fileB = JSON.parse(await fs.readFile(path.join(tmp, "open-workspaces.flav-b.json"), "utf8"));
    expect(fileA.roots).toEqual(regA.list().map((w) => w.root));
    expect(fileB.roots).toEqual(regB.list().map((w) => w.root));

    // Recents merged in the shared file, which carries no flavored roots.
    const sharedParsed = JSON.parse(await fs.readFile(shared, "utf8"));
    expect(sharedParsed.roots).toBeUndefined();
    expect(sharedParsed.recents.map((r: { name: string }) => r.name)).toEqual(["alpha", "beta"]);

    // A later persist from A (which never saw beta) must not drop B's recent.
    const wsC = path.join(tmp, "gamma");
    await fs.mkdir(wsC);
    await regA.open(wsC);
    const merged = JSON.parse(await fs.readFile(shared, "utf8"));
    expect(merged.recents.map((r: { name: string }) => r.name).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("migrates from the legacy shared file, then prefers its own flavor file", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);
    const shared = path.join(tmp, "open-workspaces.json");
    // Legacy layout: a pre-flavor server persisted its open set here.
    await fs.writeFile(shared, JSON.stringify({ roots: [wsA] }), "utf8");

    const reg = new WorkspaceRegistry(() => {}, shared, null, "flav-a");
    cleanups.push(() => reg.closeAll());
    await reg.restorePersisted();
    expect(reg.list().map((w) => w.name)).toEqual(["alpha"]);
    // Restoring persisted the migrated set into the flavor file.
    const flavorFile = path.join(tmp, "open-workspaces.flav-a.json");
    expect(JSON.parse(await fs.readFile(flavorFile, "utf8")).roots).toEqual(
      reg.list().map((w) => w.root),
    );
    await reg.closeAll();

    // Once the flavor file exists it wins — a stale legacy `roots` (say from
    // a still-running legacy server) is no longer consulted.
    await fs.writeFile(shared, JSON.stringify({ roots: [wsB] }), "utf8");
    const reg2 = new WorkspaceRegistry(() => {}, shared, null, "flav-a");
    cleanups.push(() => reg2.closeAll());
    await reg2.restorePersisted();
    expect(reg2.list().map((w) => w.name)).toEqual(["alpha"]);
  });
});

describe("WorkspaceRegistry terminal restore", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-termrestore-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A dead terminal record — seeded directly so no real PTY ever spawns. */
  function seedOf(id: string): TerminalSeed {
    return {
      info: {
        id,
        cwd: ".",
        shell: "/bin/fake",
        title: null,
        status: "exited",
        exitCode: 0,
        createdAt: new Date().toISOString(),
        cols: 100,
        rows: 30,
      },
      chunks: [{ terminalId: id, seq: 0, stream: "stdout", text: `scrollback of ${id}\r\n` }],
    };
  }

  it("close() stashes the workspace's terminal tabs and reopening seeds them back", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);

    const registry = new WorkspaceRegistry(() => {}, path.join(tmp, "open-workspaces.json"));
    cleanups.push(() => registry.closeAll());
    const rtA = await registry.open(wsA);
    await registry.open(wsB); // the last workspace cannot be closed

    // Stand in for terminals the user had open (exited, no pty — close()'s
    // kill sweep is a no-op on them, which is exactly the post-kill state).
    rtA.terminals.seed([seedOf("term-alpha-1")]);
    await registry.close(rtA.id);

    const reopened = await registry.open(wsA);
    expect(reopened).not.toBe(rtA);
    const listed = reopened.terminals.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "term-alpha-1", status: "exited" });
    expect(reopened.terminals.buffer("term-alpha-1").map((c) => c.text)).toEqual([
      "scrollback of term-alpha-1\r\n",
    ]);

    // The stash is consumed on reopen: kill the restored tab, close again,
    // and the next open starts clean instead of resurrecting it.
    await reopened.terminals.kill("term-alpha-1");
    await registry.close(reopened.id);
    const third = await registry.open(wsA);
    expect(third.terminals.list()).toEqual([]);
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
