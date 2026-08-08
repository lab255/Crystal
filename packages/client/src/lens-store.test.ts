import { describe, expect, it, vi } from "vitest";
import type { BridgeMethods, CodeIndex, SystemOverview } from "@crystal/core";
import { createWorkspaceFacet } from "@crystal/core";
import { createLensStore } from "./lens-store.js";
import type { BridgeClient } from "./bridge-client.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A BridgeClient stub answering only the methods lens resolution uses. */
function stubClient(handlers: {
  [M in keyof BridgeMethods]?: (
    params: BridgeMethods[M]["params"],
  ) => BridgeMethods[M]["result"] | Promise<BridgeMethods[M]["result"]>;
}): BridgeClient {
  return {
    request: vi.fn(async (method: string, params: unknown) => {
      const handler = handlers[method as keyof BridgeMethods];
      if (!handler) throw new Error(`unexpected bridge call: ${method}`);
      return handler(params as never);
    }),
  } as unknown as BridgeClient;
}

const index: CodeIndex = {
  version: 1,
  files: [
    {
      path: "src/auth/login.ts",
      module: "src/auth",
      tags: [{ tag: "intent:auth", evidence: "name" }],
      symbols: [],
    },
    {
      path: "src/forms/api.ts",
      module: "src/forms",
      tags: [],
      symbols: [],
    },
  ],
  generatedAt: "2026-07-20T00:00:00Z",
} as unknown as CodeIndex;

const overview = {
  systems: [
    { id: "sys:forms", parts: [{ path: "src/forms", pkg: "app", fileCount: 3 }] },
  ],
  links: [],
  fileTotal: 2,
  generatedAt: "2026-07-20T00:00:00Z",
} as unknown as SystemOverview;

describe("lens store", () => {
  it("resolves a tags lens from the code index and sys: parts", async () => {
    const store = createLensStore(
      stubClient({
        "codeindex.get": () => ({ index, staleFiles: [] }),
        "codemap.overview": () => overview,
      }),
    );
    await store.getState().ensure("ws1", "intent:auth,sys:forms");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.membership).toMatchObject({ files: ["src/auth/login.ts"], dirs: ["src/forms"] });
    expect(s.matcher.file("src/auth/login.ts")).toBe(true);
    expect(s.matcher.file("src/forms/api.ts")).toBe(true);
    expect(s.matcher.file("src/other.ts")).toBe(false);
  });

  it("resolves a diff lens through git.changedFiles (ref scope included)", async () => {
    const calls: unknown[] = [];
    const store = createLensStore(
      stubClient({
        "git.changedFiles": (params) => {
          calls.push(params);
          return { files: ["src/forms/api.ts"], base: "origin/main" };
        },
      }),
    );
    await store.getState().ensure("ws1", "diff:ref:origin/main");
    expect(calls[0]).toMatchObject({ ws: "ws1", ref: "origin/main" });
    const s = store.getState();
    expect(s.membership).toMatchObject({ files: ["src/forms/api.ts"], base: "origin/main" });
    expect(s.matcher.empty).toBe(false);
  });

  it("resolves a saved facet through its stored spec, and dangles to empty", async () => {
    const facet = createWorkspaceFacet("Auth", { kind: "tags", tags: ["intent:auth"] });
    const store = createLensStore(
      stubClient({
        "facets.get": () => ({ facets: [facet] }),
        "codeindex.get": () => ({ index, staleFiles: [] }),
      }),
    );
    await store.getState().ensure("ws1", `facet:${facet.id}`);
    expect(store.getState().membership?.files).toEqual(["src/auth/login.ts"]);

    await store.getState().ensure("ws1", "facet:gone");
    expect(store.getState().status).toBe("ready");
    expect(store.getState().matcher.empty).toBe(true);
  });

  it("ensure is idempotent per (ws, raw) and clears on null", async () => {
    const get = vi.fn(() => ({ index, staleFiles: [] }));
    const store = createLensStore(stubClient({ "codeindex.get": get }));
    await store.getState().ensure("ws1", "intent:auth");
    await store.getState().ensure("ws1", "intent:auth");
    expect(get).toHaveBeenCalledTimes(1);
    await store.getState().ensure("ws1", null);
    expect(store.getState().spec).toBeNull();
    expect(store.getState().status).toBe("idle");
  });

  it("marks resolution failures as error without throwing", async () => {
    const store = createLensStore(
      stubClient({
        "git.changedFiles": () => {
          throw new Error("not a git repo");
        },
      }),
    );
    await store.getState().ensure("ws1", "diff:worktree");
    const s = store.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("not a git repo");
    expect(s.matcher.empty).toBe(true);
  });

  it("saveFacet round-trips through facets.save and updates the cache", async () => {
    const saved: unknown[] = [];
    const store = createLensStore(
      stubClient({
        "facets.get": () => ({ facets: [] }),
        "facets.save": (p) => {
          saved.push(p);
          return { ok: true };
        },
      }),
    );
    const facet = createWorkspaceFacet("Diffs", { kind: "diff", scope: "worktree" });
    await store.getState().saveFacet("ws1", facet);
    expect(store.getState().facets).toEqual([facet]);
    expect(saved[0]).toMatchObject({ ws: "ws1", facets: [facet] });
  });

  it("does not let a stale workspace facet load replace the active cache", async () => {
    const a = deferred<BridgeMethods["facets.get"]["result"]>();
    const b = deferred<BridgeMethods["facets.get"]["result"]>();
    const facetA = createWorkspaceFacet("Workspace A", { kind: "tags", tags: ["intent:a"] });
    const facetB = createWorkspaceFacet("Workspace B", { kind: "tags", tags: ["intent:b"] });
    const store = createLensStore(
      stubClient({
        "facets.get": ({ ws }) => (ws === "a" ? a.promise : b.promise),
      }),
    );

    const loadA = store.getState().loadFacets("a");
    const loadB = store.getState().loadFacets("b");
    b.resolve({ facets: [facetB] });
    await loadB;
    a.resolve({ facets: [facetA] });
    await loadA;

    expect(store.getState().facetsWs).toBe("b");
    expect(store.getState().facets).toEqual([facetB]);
  });
});
