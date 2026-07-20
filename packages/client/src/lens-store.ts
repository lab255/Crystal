import { createStore, type StoreApi } from "zustand/vanilla";
import {
  buildLensMatcher,
  indexFacetVisibility,
  parseLensParam,
  type LensMatcher,
  type LensMembership,
  type LensSpec,
  type WorkspaceFacet,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * The global lens, resolved. The nav store owns *which* lens is active (the
 * top-level `lens` deep-link param); this store turns that spec into concrete
 * membership — the files a tag facet exposes (code index), the parts of a
 * `sys:` system (overview), or a diff's changed files (git) — and hands every
 * view one precomputed `matcher`. It also caches the workspace facet registry
 * (`.crystal/facets.json`).
 *
 * The provider wires `ensure` to nav/workspace changes and re-resolves diff
 * lenses when the code map re-analyzes (source changed), so a worktree lens
 * follows the edit stream without any view asking.
 */
export interface LensState {
  /** `${ws}|${raw}` of the current resolution — the ensure() idempotence key. */
  key: string | null;
  spec: LensSpec | null;
  membership: LensMembership | null;
  matcher: LensMatcher;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Saved workspace facets of `facetsWs` (empty until first load). */
  facets: WorkspaceFacet[];
  facetsWs: string | null;
  /** Resolve the raw lens param for a workspace; cheap no-op when unchanged. */
  ensure(ws: string | null, raw: string | null | undefined, force?: boolean): Promise<void>;
  /** Re-resolve the current lens (diff lenses go stale as files change). */
  refresh(): Promise<void>;
  loadFacets(ws: string): Promise<WorkspaceFacet[]>;
  /** Add or replace one saved facet and persist the registry. */
  saveFacet(ws: string, facet: WorkspaceFacet): Promise<void>;
  removeFacet(ws: string, id: string): Promise<void>;
}

export type LensStore = StoreApi<LensState>;

const EMPTY_MATCHER = buildLensMatcher(null);

export function createLensStore(client: BridgeClient): LensStore {
  let epoch = 0;

  return createStore<LensState>((set, get) => {
    async function resolveSpec(ws: string, spec: LensSpec): Promise<LensMembership> {
      if (spec.kind === "facet") {
        const facets = await get().loadFacets(ws);
        const saved = facets.find((f) => f.id === spec.id);
        // A dangling facet id resolves to nothing rather than throwing — the
        // registry may have been edited on another machine.
        if (!saved) return { files: [], dirs: [] };
        return resolveSpec(ws, saved.spec);
      }
      if (spec.kind === "diff") {
        const params =
          typeof spec.scope === "string"
            ? { ws, scope: spec.scope }
            : ({ ws, scope: "base", ref: spec.scope.ref } as const);
        const { files, base } = await client.request("git.changedFiles", params);
        return { files, dirs: [], base };
      }
      const sysTags = spec.tags.filter((t) => t.startsWith("sys:"));
      const intentTags = spec.tags.filter((t) => !t.startsWith("sys:"));
      const files: string[] = [];
      const dirs: string[] = [];
      if (intentTags.length > 0) {
        const { index } = await client.request("codeindex.get", { ws });
        const vis = indexFacetVisibility(index, intentTags);
        files.push(...vis.files.keys());
      }
      if (sysTags.length > 0) {
        const overview = await client.request("codemap.overview", { ws });
        for (const id of sysTags) {
          const sys = overview.systems.find((s) => s.id === id);
          if (sys) dirs.push(...sys.parts.map((p) => p.path));
        }
      }
      return { files, dirs };
    }

    return {
      key: null,
      spec: null,
      membership: null,
      matcher: EMPTY_MATCHER,
      status: "idle",
      error: null,
      facets: [],
      facetsWs: null,

      async ensure(ws, raw, force = false) {
        const spec = raw ? parseLensParam(raw) : null;
        if (!ws || !spec) {
          if (get().key !== null || get().spec !== null) {
            set({
              key: null,
              spec: null,
              membership: null,
              matcher: EMPTY_MATCHER,
              status: "idle",
              error: null,
            });
          }
          return;
        }
        const key = `${ws}|${raw}`;
        if (!force && get().key === key && get().status !== "error") return;
        const myEpoch = ++epoch;
        set({ key, spec, status: "loading", error: null });
        try {
          const membership = await resolveSpec(ws, spec);
          if (epoch !== myEpoch) return; // superseded while resolving
          set({ membership, matcher: buildLensMatcher(membership), status: "ready" });
        } catch (err) {
          if (epoch !== myEpoch) return;
          set({
            membership: null,
            matcher: EMPTY_MATCHER,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      async refresh() {
        const { key } = get();
        if (!key) return;
        const sep = key.indexOf("|");
        await get().ensure(key.slice(0, sep), key.slice(sep + 1), true);
      },

      async loadFacets(ws) {
        if (get().facetsWs === ws) return get().facets;
        const { facets } = await client.request("facets.get", { ws });
        set({ facets, facetsWs: ws });
        return facets;
      },

      async saveFacet(ws, facet) {
        const current = await get().loadFacets(ws);
        const facets = [...current.filter((f) => f.id !== facet.id), facet];
        set({ facets, facetsWs: ws });
        await client.request("facets.save", { ws, facets });
      },

      async removeFacet(ws, id) {
        const current = await get().loadFacets(ws);
        const facets = current.filter((f) => f.id !== id);
        set({ facets, facetsWs: ws });
        await client.request("facets.save", { ws, facets });
      },
    };
  });
}
