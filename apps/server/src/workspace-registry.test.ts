import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRun, createArchOverlay } from "@crystal/core";
import { browseDirs, expandHome } from "./browse.js";
import { packageNameOf, type CrossSurface } from "./code-map.js";
import type { TerminalSeed } from "./terminal-manager.js";
import { WorkspaceRegistry, WorkspaceRuntime, computeCrossEdges } from "./workspace-registry.js";

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

describe("WorkspaceRegistry.crossInfra", () => {
  it("sorts projects by name and bounds a runtime failure", async () => {
    const registry = new WorkspaceRegistry(() => {}, null);
    const good = {
      id: "good",
      name: "Zulu",
      loadArchOverlay: vi.fn(async () => ({ ...createArchOverlay(), environments: [] })),
      codemap: {
        summary: vi.fn(async () => ({ modules: [], deps: [], externals: [], fileTotal: 0, generatedAt: "then" })),
        systemOverview: vi.fn(async () => ({ systems: [], links: [], fileTotal: 0, generatedAt: "then" })),
        surfaces: vi.fn(async () => ({ screens: [] })),
        surfaceMap: vi.fn(async () => ({ calls: [] })),
      },
      codeindex: { get: vi.fn(async () => ({ index: {} })) },
    };
    const bad = {
      id: "bad",
      name: "Alpha",
      loadArchOverlay: vi.fn(async () => { throw new Error("overlay corrupt"); }),
      codemap: good.codemap,
      codeindex: good.codeindex,
    };
    (registry as unknown as { runtimes: Map<string, unknown> }).runtimes = new Map([
      ["good", good], ["bad", bad],
    ]);

    const result = await registry.crossInfra();
    expect(result.projects.map((project) => project.name)).toEqual(["Alpha", "Zulu"]);
    expect(result.projects[0]).toEqual({
      ws: "bad", name: "Alpha", environments: [], error: "overlay corrupt",
    });
    expect(result.projects[1]).toMatchObject({ ws: "good", name: "Zulu", environments: [] });
    expect(result.shared).toEqual([]);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes placements on screen nodes derived from runtime surfaces", async () => {
    const registry = new WorkspaceRegistry(() => {}, null);
    const screenId = "screen:react-router:/checkout";
    const runtime = {
      id: "shop",
      name: "Shop",
      loadArchOverlay: vi.fn(async () => ({
        ...createArchOverlay(),
        environments: [{
          id: "prod", name: "Production", kind: "cloud" as const,
          targets: [{ id: "web", name: "Web", kind: "static" as const }],
        }],
        overrides: {
          [screenId]: { placements: { prod: { target: "Web", targetId: "web", runtime: "" } } },
        },
      })),
      codemap: {
        summary: vi.fn(async () => ({
          modules: [{ path: "apps/web", name: "web", fileCount: 1 }],
          deps: [], externals: [], fileTotal: 1, generatedAt: "then",
        })),
        systemOverview: vi.fn(async () => ({ systems: [], links: [], fileTotal: 1, generatedAt: "then" })),
        surfaces: vi.fn(async () => ({ screens: [{
          id: "react-router:/checkout", route: "/checkout",
          file: "apps/web/src/Checkout.tsx", source: "react-router" as const,
        }] })),
        surfaceMap: vi.fn(async () => ({ calls: [] })),
      },
      codeindex: { get: vi.fn(async () => ({ index: {} })) },
    };
    (registry as unknown as { runtimes: Map<string, unknown> }).runtimes = new Map([["shop", runtime]]);

    const result = await registry.crossInfra();

    expect(result.projects[0]!.environments[0]!.nodes).toContainEqual({
      id: screenId, label: "/checkout", kind: "frontend", targetId: "web",
    });
  });

  it("derives without surfaces when surface analysis is unavailable", async () => {
    const registry = new WorkspaceRegistry(() => {}, null);
    const runtime = {
      id: "plain", name: "Plain",
      loadArchOverlay: vi.fn(async () => ({ ...createArchOverlay(), environments: [] })),
      codemap: {
        summary: vi.fn(async () => ({ modules: [], deps: [], externals: [], fileTotal: 0, generatedAt: "then" })),
        systemOverview: vi.fn(async () => ({ systems: [], links: [], fileTotal: 0, generatedAt: "then" })),
        surfaces: vi.fn(async () => { throw new Error("surfaces unavailable"); }),
        surfaceMap: vi.fn(async () => ({ calls: [] })),
      },
      codeindex: { get: vi.fn(async () => ({ index: {} })) },
    };
    (registry as unknown as { runtimes: Map<string, unknown> }).runtimes = new Map([["plain", runtime]]);
    expect((await registry.crossInfra()).projects[0]).toMatchObject({
      ws: "plain", name: "Plain", environments: [],
    });
  });
});

describe("WorkspaceRuntime.loadArchOverlay", () => {
  it("shares an in-flight successful load for the runtime lifetime", async () => {
    const loadArchOverlay = vi.fn(async () => createArchOverlay());
    const runtime = Object.assign(Object.create(WorkspaceRuntime.prototype), {
      archOverlayLoad: null, store: { loadArchOverlay },
    }) as WorkspaceRuntime;
    const load = runtime.loadArchOverlay.bind(runtime);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(second);
    await load();
    expect(loadArchOverlay).toHaveBeenCalledTimes(1);
  });

  it("clears a failed load so the next call can retry", async () => {
    const overlay = createArchOverlay();
    const loadArchOverlay = vi.fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce(overlay);
    const runtime = Object.assign(Object.create(WorkspaceRuntime.prototype), {
      archOverlayLoad: null, store: { loadArchOverlay },
    }) as WorkspaceRuntime;
    const load = runtime.loadArchOverlay.bind(runtime);
    await expect(load()).rejects.toThrow("temporary read failure");
    await expect(load()).resolves.toBe(overlay);
    expect(loadArchOverlay).toHaveBeenCalledTimes(2);
  });

  it("serves the saved overlay instead of the boot-time memo", async () => {
    const bootOverlay = createArchOverlay();
    const savedOverlay = { ...createArchOverlay(), version: 2 as const };
    const loadArchOverlay = vi.fn(async () => bootOverlay);
    const saveArchOverlay = vi.fn(async () => {});
    const runtime = Object.assign(Object.create(WorkspaceRuntime.prototype), {
      archOverlayLoad: null, store: { loadArchOverlay, saveArchOverlay },
    }) as WorkspaceRuntime;

    await expect(runtime.loadArchOverlay()).resolves.toBe(bootOverlay);
    await runtime.saveArchOverlay(savedOverlay);

    await expect(runtime.loadArchOverlay()).resolves.toBe(savedOverlay);
    expect(loadArchOverlay).toHaveBeenCalledTimes(1);
    expect(saveArchOverlay).toHaveBeenCalledWith(savedOverlay);
  });

  it("does not let a concurrent first load resurrect the old overlay after save", async () => {
    const bootOverlay = createArchOverlay();
    const savedOverlay = { ...createArchOverlay(), version: 2 as const };
    let finishLoad!: (overlay: typeof bootOverlay) => void;
    const loadArchOverlay = vi.fn(() => new Promise<typeof bootOverlay>((resolve) => {
      finishLoad = resolve;
    }));
    const saveArchOverlay = vi.fn(async () => {});
    const runtime = Object.assign(Object.create(WorkspaceRuntime.prototype), {
      archOverlayLoad: null, store: { loadArchOverlay, saveArchOverlay },
    }) as WorkspaceRuntime;

    const firstGet = runtime.loadArchOverlay();
    const save = runtime.saveArchOverlay(savedOverlay);
    expect(saveArchOverlay).not.toHaveBeenCalled();

    finishLoad(bootOverlay);
    await expect(firstGet).resolves.toBe(bootOverlay);
    await save;

    await expect(runtime.loadArchOverlay()).resolves.toBe(savedOverlay);
    expect(loadArchOverlay).toHaveBeenCalledTimes(1);
    expect(saveArchOverlay).toHaveBeenCalledWith(savedOverlay);
  });
});

describe("WorkspaceRuntime question filing", () => {
  it("routes a taskless CRYSTAL_QUESTION marker through task auto-creation", async () => {
    const run = {
      ...createAgentRun({
        prompt: "review the design",
        purpose: "code-review",
        tags: ["workflow:wf_1"],
      }),
      id: "run_marker",
    };
    const addQuestionForRun = vi.fn(async () => ({
      ok: true as const,
      taskId: "task_auto",
      questionId: "q_auto",
      taskCreated: true,
    }));
    const runtime = {
      agents: { get: async () => run },
      orchestration: {
        projectPathForRun: async () => ".crystal/projects/general.json",
        addQuestionForRun,
      },
      workflows: { workflowForRun: async () => ({ epicId: "epic_1" }) },
    };
    const fileQuestion = (
      WorkspaceRuntime.prototype as unknown as {
        fileQuestion(this: typeof runtime, runId: string, text: string): Promise<void>;
      }
    ).fileQuestion;

    await fileQuestion.call(runtime, run.id, "Approve the dependency change?");

    expect(addQuestionForRun).toHaveBeenCalledWith(
      ".crystal/projects/general.json",
      run,
      "Approve the dependency change?",
      undefined,
      { epicId: "epic_1" },
    );
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

  it("keeps a closed workspace in the persisted reopen list across a restart", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);
    const persistFile = path.join(tmp, "open-workspaces.json");

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    const a = await registry.open(wsA);
    await registry.open(wsB);
    await registry.close(a.id);
    // Closed: out of the open set, still in the reopen list.
    expect(registry.list().map((w) => w.name)).toEqual(["beta"]);
    await registry.closeAll();

    // A full restart (fresh registry, same file): the closed workspace is
    // still offered, and reopening it works.
    const restarted = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => restarted.closeAll());
    const recent = (await restarted.recents()).find((r) => r.name === "alpha");
    expect(recent?.root).toBe(await fs.realpath(wsA));
    expect(recent?.missing).toBeFalsy();
    const reopened = await restarted.open(recent!.root);
    expect(reopened.name).toBe("alpha");
  });

  it("has no default workspace until one is open", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    await fs.mkdir(wsA);
    const registry = new WorkspaceRegistry(() => {}, null);
    cleanups.push(() => registry.closeAll());
    // Zero workspaces is a state, not an error — `workspaces.list` reports it.
    expect(registry.defaultWs).toBeNull();
    expect(registry.list()).toEqual([]);
    const a = await registry.open(wsA);
    expect(registry.defaultWs).toBe(a.id);
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

  it("restores the persisted set even when a CLI root opens (and persists) first", async () => {
    // The real boot sequence: server.ts opens the CLI/primary root — which
    // persists, overwriting the flavor file — and only then restores. The
    // restore must see the previous session's set, not that fresh write.
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    const wsB = path.join(tmp, "beta");
    const primary = path.join(tmp, "primary");
    await fs.mkdir(wsA);
    await fs.mkdir(wsB);
    await fs.mkdir(primary);
    const shared = path.join(tmp, "open-workspaces.json");

    const prev = new WorkspaceRegistry(() => {}, shared, null, "flav-a");
    cleanups.push(() => prev.closeAll());
    await prev.open(wsA);
    await prev.open(wsB);
    await prev.closeAll();

    const next = new WorkspaceRegistry(() => {}, shared, null, "flav-a");
    cleanups.push(() => next.closeAll());
    await next.open(primary);
    await next.restorePersisted();
    expect(next.list().map((w) => w.name).sort()).toEqual(["alpha", "beta", "primary"]);
    // The CLI root opened first stays the default.
    expect(next.get().root).toBe(await fs.realpath(primary));

    // And the file now holds the full merged set for the next restart.
    const flavorFile = path.join(tmp, "open-workspaces.flav-a.json");
    const persisted = JSON.parse(await fs.readFile(flavorFile, "utf8"));
    expect(persisted.roots.sort()).toEqual(next.list().map((w) => w.root).sort());
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

describe("WorkspaceRegistry safe-mode restore", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-safemode-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** Persisted set + a simulated crash marker (the previous restore never finished). */
  async function crashedSetup(): Promise<{ persistFile: string; roots: string[] }> {
    const tmp = await tmpDir();
    await fs.mkdir(path.join(tmp, "alpha"));
    await fs.mkdir(path.join(tmp, "beta"));
    const persistFile = path.join(tmp, "open-workspaces.json");
    const seed = new WorkspaceRegistry(() => {}, persistFile);
    await seed.open(path.join(tmp, "alpha"));
    await seed.open(path.join(tmp, "beta"));
    await seed.closeAll();
    const { roots } = JSON.parse(await fs.readFile(persistFile, "utf8"));
    await fs.writeFile(`${persistFile}.restoring`, JSON.stringify({ roots }), "utf8");
    return { persistFile, roots };
  }

  it("holds roots back behind a leftover crash marker until the user restores", async () => {
    const { persistFile, roots } = await crashedSetup();

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    await registry.restorePersisted();
    // Safe mode: nothing opened, the crashed set is held for the prompt.
    expect(registry.list()).toEqual([]);
    expect(registry.pendingRestore()).toEqual(roots);

    await registry.restorePending();
    expect(registry.list().map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(registry.pendingRestore()).toBeNull();
    // The marker is gone — the retried restore completed.
    await expect(fs.stat(`${persistFile}.restoring`)).rejects.toThrow();
    await registry.closeAll();

    // Next boot restores normally again, and leaves no marker behind.
    const registry2 = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry2.closeAll());
    await registry2.restorePersisted();
    expect(registry2.list().map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(registry2.pendingRestore()).toBeNull();
    await expect(fs.stat(`${persistFile}.restoring`)).rejects.toThrow();
  });

  it("dismissing safe mode drops the held-back roots but keeps them in recents", async () => {
    const { persistFile } = await crashedSetup();

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    await registry.restorePersisted();
    expect(registry.pendingRestore()).not.toBeNull();

    await registry.dismissPendingRestore();
    expect(registry.pendingRestore()).toBeNull();
    await expect(fs.stat(`${persistFile}.restoring`)).rejects.toThrow();
    // The stored open set now reflects reality (nothing open)…
    expect(JSON.parse(await fs.readFile(persistFile, "utf8")).roots).toEqual([]);
    // …so the next boot starts clean, but the reopen list still has both.
    const registry2 = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry2.closeAll());
    await registry2.restorePersisted();
    expect(registry2.list()).toEqual([]);
    expect((await registry2.recents()).map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("a corrupt marker still counts as a crashed restore, falling back to the persisted set", async () => {
    const { persistFile, roots } = await crashedSetup();
    await fs.writeFile(`${persistFile}.restoring`, "not json", "utf8");

    const registry = new WorkspaceRegistry(() => {}, persistFile);
    cleanups.push(() => registry.closeAll());
    await registry.restorePersisted();
    expect(registry.list()).toEqual([]);
    expect(registry.pendingRestore()).toEqual(roots);
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
      // Any absolute path is listable and `parent` walks to the filesystem
      // root, so the picker can reach folders outside home.
      const root = await browseDirs(path.parse(path.resolve(tmp)).root);
      expect(root.parent).toBeNull();
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

  it("expands a leading ~ (typed paths never meet a shell)", async () => {
    expect((await browseDirs("~")).path).toBe(path.resolve(os.homedir()));
    expect(expandHome("~/x/y")).toBe(path.join(os.homedir(), "x/y"));
    expect(expandHome("~notme/x")).toBe("~notme/x");
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});
