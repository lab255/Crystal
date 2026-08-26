import { createStore, type StoreApi } from "zustand/vanilla";
import {
  buildLensMatcher,
  indexFacetVisibility,
  parseLensParam,
  type LensMatcher,
  type LensMembership,
  type LensSpec,
  type WorkspaceFacet,
  type AgentRun,
  type CodeIndexProgress,
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
  /** Workspaces with a live intent-index agent run. */
  indexingByWs: Record<string, boolean>;
  /** Workspace-keyed live or interrupted chained-index details. */
  indexProgressByWs: Record<string, IntentIndexState>;
  /** Resolve the raw lens param for a workspace; cheap no-op when unchanged. */
  ensure(ws: string | null, raw: string | null | undefined, force?: boolean): Promise<void>;
  /** Re-resolve the current lens (diff lenses go stale as files change). */
  refresh(): Promise<void>;
  loadFacets(ws: string): Promise<WorkspaceFacet[]>;
  /** Add or replace one saved facet and persist the registry. */
  saveFacet(ws: string, facet: WorkspaceFacet): Promise<void>;
  removeFacet(ws: string, id: string): Promise<void>;
  /** Start intent indexing unless that workspace already has a live index run. */
  requestIntentIndex(ws: string, options?: { files?: string[]; full?: boolean }): Promise<boolean>;
}

export interface IntentIndexState extends CodeIndexProgress {
  status: "live" | "interrupted" | "auth";
  remaining: number;
}

export type IntentIndexAction =
  | { type: "progress"; progress: CodeIndexProgress }
  | { type: "run"; ws: string; run: Pick<AgentRun, "id" | "purpose" | "status" | "failure"> };

/** Pure workspace-keyed fold shared by event wiring and resume-gating tests. */
export function reduceIntentIndexState(
  state: Record<string, IntentIndexState>,
  action: IntentIndexAction,
): Record<string, IntentIndexState> {
  if (action.type === "progress") {
    const p = action.progress;
    return {
      ...state,
      [p.ws]: { ...p, status: "live", remaining: Math.max(0, p.total - p.indexed) },
    };
  }
  const { ws, run } = action;
  if (run.purpose !== "index") return state;
  const current = state[ws];
  if (!current || current.run !== run.id) return state;
  if (run.status === "failed" || run.status === "cancelled") {
    return {
      ...state,
      [ws]: {
        ...current,
        status: isAuthIndexFailure(run) ? "auth" : "interrupted",
      },
    };
  }
  return state;
}

/** The one auth-gating rule: an auth-classified index failure must never offer resume. */
export function isAuthIndexFailure(run: { failure?: { kind?: string } | null }): boolean {
  return run.failure?.kind === "auth";
}

export function canResumeIntentIndex(progress: IntentIndexState | undefined): boolean {
  return progress?.status === "interrupted" && progress.remaining > 0;
}

export type LensStore = StoreApi<LensState>;

const EMPTY_MATCHER = buildLensMatcher(null);

export function createLensStore(client: BridgeClient): LensStore {
  let epoch = 0;
  let facetsEpoch = 0;
  const intentIndexRequests = new Set<string>();

  const store = createStore<LensState>((set, get) => {
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
      indexingByWs: {},
      indexProgressByWs: {},

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
        const myEpoch = ++facetsEpoch;
        const { facets } = await client.request("facets.get", { ws });
        if (facetsEpoch !== myEpoch) return facets;
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

      async requestIntentIndex(ws, options = {}) {
        if (intentIndexRequests.has(ws) || get().indexingByWs[ws]) return false;
        intentIndexRequests.add(ws);
        set((state) => ({ indexingByWs: { ...state.indexingByWs, [ws]: true } }));
        try {
          const { runs } = await client.request("agent.list", { ws });
          if (runs.some((run) => run.purpose === "index" && (run.status === "queued" || run.status === "running"))) {
            return false;
          }
          await client.request("codeindex.enrich", { ws, ...options });
          return true;
        } catch (error) {
          set((state) => ({ indexingByWs: { ...state.indexingByWs, [ws]: false } }));
          throw error;
        } finally {
          intentIndexRequests.delete(ws);
        }
      },
    };
  });

  client.events?.on("agent.runChanged", ({ ws, run }) => {
    if (run.purpose !== "index") return;
    const live = run.status === "queued" || run.status === "running";
    if (!live && intentIndexRequests.has(ws)) return;
    store.setState((state) => ({
      indexingByWs: { ...state.indexingByWs, [ws]: live },
      indexProgressByWs: reduceIntentIndexState(state.indexProgressByWs, { type: "run", ws, run }),
    }));
  });
  client.events?.on("codeindex.progress", (progress) => {
    store.setState((state) => ({
      indexingByWs: { ...state.indexingByWs, [progress.ws]: progress.indexed < progress.total },
      indexProgressByWs: reduceIntentIndexState(state.indexProgressByWs, { type: "progress", progress }),
    }));
  });
  client.events?.on("codeindex.changed", ({ ws }) => {
    // A full drain may start another batch after each index write; reconcile
    // against server truth rather than briefly presenting it as settled.
    void client.request("agent.list", { ws }).then(({ runs }) => {
      if (intentIndexRequests.has(ws)) return;
      const live = runs.some((run) =>
        run.purpose === "index" && (run.status === "queued" || run.status === "running")
      );
      store.setState((state) => ({ indexingByWs: { ...state.indexingByWs, [ws]: live } }));
    }).catch(() => undefined);
  });
  return store;
}
