import { createStore, type StoreApi } from "zustand/vanilla";
import { AGENTS_FILE, ARCH_OVERLAY_FILE } from "@crystal/core";
import type {
  AgentRoster,
  ArchDraft,
  ArchOverlay,
  ArchitectureGraph,
  Project,
  WorkspaceInfo,
  WorkspaceManifest,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

export interface WorkspaceState {
  info: WorkspaceInfo | null;
  /** Agent roster (`.crystal/agents.json`) — dispatch profiles + default human. */
  roster: AgentRoster | null;
  /**
   * The canonical architecture's user-authored half (see core arch-overlay.ts).
   * Null until `loadArchOverlay` — the first server read migrates legacy
   * diagrams into it.
   */
  archOverlay: ArchOverlay | null;
  loading: boolean;
  error: string | null;
  /** Paths with unsaved (debounced, in-flight) changes. */
  pendingSaves: Record<string, boolean>;
  /** Paths whose latest persistence attempt failed and remain retryable. */
  failedSaves: Record<string, boolean>;

  refresh(): Promise<void>;
  /** Fetch the architecture overlay once, or refetch it after a remote save. */
  loadArchOverlay(force?: boolean): Promise<void>;
  /** Optimistically update + debounce-persist the architecture overlay. */
  updateArchOverlay(overlay: ArchOverlay): void;
  saveManifest(manifest: WorkspaceManifest): Promise<void>;
  /** Optimistically update + debounce-persist an architecture graph. */
  updateArchitecture(path: string, graph: ArchitectureGraph): void;
  createArchitecture(name: string): Promise<{ path: string; graph: ArchitectureGraph }>;
  deleteArchitecture(path: string): Promise<void>;
  /** Optimistically update + debounce-persist an architecture draft. */
  updateArchDraft(path: string, draft: ArchDraft): void;
  createArchDraft(draft: ArchDraft): Promise<{ path: string; draft: ArchDraft }>;
  deleteArchDraft(path: string): Promise<void>;
  /** Optimistically update + debounce-persist a project board. */
  updateProject(path: string, project: Project): void;
  createProject(name: string): Promise<{ path: string; project: Project }>;
  /** Optimistically update + debounce-persist the agent roster. */
  updateRoster(roster: AgentRoster): void;
  /** Flush all debounced saves immediately. */
  flush(): Promise<void>;
}

const SAVE_DEBOUNCE_MS = 700;

export type WorkspaceStore = StoreApi<WorkspaceState>;

export function createWorkspaceStore(client: BridgeClient): WorkspaceStore {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushers = new Map<string, () => Promise<void>>();
  const pathsBySave = new Map<string, string>();
  const failedSaveKeys = new Set<string>();
  let refreshEpoch = 0;
  let overlayEpoch = 0;

  const store = createStore<WorkspaceState>((set, get) => {
    const hasPendingPath = (path: string) =>
      [...flushers.keys()].some((key) => pathsBySave.get(key) === path);
    const hasFailedPath = (path: string) =>
      [...failedSaveKeys].some((key) => pathsBySave.get(key) === path);

    function schedule(ws: string, path: string, save: () => Promise<void>): void {
      const key = `${ws}\0${path}`;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      failedSaveKeys.delete(key);
      pathsBySave.set(key, path);
      set((s) => {
        const failedSaves = { ...s.failedSaves };
        if (!hasFailedPath(path)) delete failedSaves[path];
        return { pendingSaves: { ...s.pendingSaves, [path]: true }, failedSaves };
      });
      let inFlight: Promise<void> | null = null;
      const doSave = (): Promise<void> => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
          if (flushers.get(key) === doSave) timers.delete(key);
          try {
            await save();
          } catch (err) {
            if (flushers.get(key) === doSave) {
              failedSaveKeys.add(key);
              set((s) => ({
                error: err instanceof Error ? err.message : String(err),
                pendingSaves: { ...s.pendingSaves, [path]: true },
                failedSaves: { ...s.failedSaves, [path]: true },
              }));
            }
            throw err;
          }
          // An edit scheduled during this request owns the new flusher and
          // remains dirty until its own snapshot has landed.
          if (flushers.get(key) !== doSave) return;
          flushers.delete(key);
          failedSaveKeys.delete(key);
          pathsBySave.delete(key);
          set((s) => {
            const pendingSaves = { ...s.pendingSaves };
            const failedSaves = { ...s.failedSaves };
            if (!hasPendingPath(path)) delete pendingSaves[path];
            if (!hasFailedPath(path)) delete failedSaves[path];
            return { pendingSaves, failedSaves };
          });
        })().finally(() => {
          inFlight = null;
        });
        return inFlight;
      };
      flushers.set(key, doSave);
      timers.set(
        key,
        setTimeout(() => void doSave().catch(() => {}), SAVE_DEBOUNCE_MS),
      );
    }

    return {
      info: null,
      roster: null,
      archOverlay: null,
      loading: false,
      error: null,
      pendingSaves: {},
      failedSaves: {},

      async refresh() {
        const ws = client.scope;
        const myEpoch = ++refreshEpoch;
        set({ loading: true });
        try {
          const [info, agents] = await Promise.all([
            client.request("workspace.get", {}),
            client.request("agents.get", {}),
          ]);
          if (refreshEpoch !== myEpoch || client.scope !== ws) return;
          const prev = get().info;
          set({
            info,
            roster: agents.roster,
            loading: false,
            error: null,
            // The overlay is workspace-scoped — a workspace switch invalidates it.
            ...(prev && prev.id !== info.id ? { archOverlay: null } : {}),
          });
        } catch (err) {
          if (refreshEpoch !== myEpoch || client.scope !== ws) return;
          set({ loading: false, error: (err as Error).message });
        }
      },

      async loadArchOverlay(force = false) {
        if (!force && get().archOverlay) return;
        const ws = client.scope;
        const myEpoch = ++overlayEpoch;
        try {
          const { overlay } = await client.request("arch.getOverlay", ws === null ? {} : { ws });
          if (overlayEpoch !== myEpoch || client.scope !== ws) return;
          if (force && get().pendingSaves[ARCH_OVERLAY_FILE]) return;
          set({ archOverlay: overlay });
        } catch (err) {
          if (overlayEpoch !== myEpoch || client.scope !== ws) return;
          set({ error: (err as Error).message });
        }
      },

      updateArchOverlay(overlay) {
        const info = get().info;
        set({ archOverlay: overlay });
        if (!info) return;
        // Capture the workspace now: a flush after the user switches
        // workspaces must still write to the one the edit was made in.
        const ws = info.id;
        schedule(ws, ARCH_OVERLAY_FILE, async () => {
          await client.request("arch.saveOverlay", { ws, overlay });
        });
      },

      async saveManifest(manifest) {
        const info = get().info;
        if (info) set({ info: { ...info, manifest } });
        await client.request("workspace.saveManifest", { manifest });
      },

      updateArchitecture(path, graph) {
        const info = get().info;
        if (!info) return;
        set({
          info: {
            ...info,
            architectures: info.architectures.map((a) =>
              a.path === path ? { ...a, graph } : a,
            ),
          },
        });
        // Capture the workspace now: a flush after the user switches
        // workspaces must still write to the one the edit was made in.
        const ws = info.id;
        schedule(ws, path, async () => {
          await client.request("arch.save", { ws, path, graph });
        });
      },

      async createArchitecture(name) {
        const created = await client.request("arch.create", { name });
        const info = get().info;
        if (info) {
          set({ info: { ...info, architectures: [...info.architectures, created] } });
        }
        return created;
      },

      async deleteArchitecture(path) {
        await client.request("arch.delete", { path });
        const info = get().info;
        if (info) {
          set({
            info: {
              ...info,
              architectures: info.architectures.filter((a) => a.path !== path),
            },
          });
        }
      },

      updateArchDraft(path, draft) {
        const info = get().info;
        if (!info) return;
        set({
          info: {
            ...info,
            archDrafts: info.archDrafts.map((d) => (d.path === path ? { ...d, draft } : d)),
          },
        });
        const ws = info.id;
        schedule(ws, path, async () => {
          await client.request("archdraft.save", { ws, path, draft });
        });
      },

      async createArchDraft(draft) {
        const created = await client.request("archdraft.create", { draft });
        const info = get().info;
        if (info) set({ info: { ...info, archDrafts: [...info.archDrafts, created] } });
        return created;
      },

      async deleteArchDraft(path) {
        await client.request("archdraft.delete", { path });
        const info = get().info;
        if (info) {
          set({
            info: { ...info, archDrafts: info.archDrafts.filter((d) => d.path !== path) },
          });
        }
      },

      updateProject(path, project) {
        const info = get().info;
        if (!info) return;
        set({
          info: {
            ...info,
            projects: info.projects.map((p) => (p.path === path ? { ...p, project } : p)),
          },
        });
        const ws = info.id;
        schedule(ws, path, async () => {
          await client.request("project.save", { ws, path, project });
        });
      },

      async createProject(name) {
        const created = await client.request("project.create", { name });
        const info = get().info;
        if (info) set({ info: { ...info, projects: [...info.projects, created] } });
        return created;
      },

      updateRoster(roster) {
        const info = get().info;
        set({ roster });
        if (!info) return;
        const ws = info.id;
        schedule(ws, AGENTS_FILE, async () => {
          await client.request("agents.save", { ws, roster });
        });
      },

      async flush() {
        const all = [...flushers.values()];
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        const results = await Promise.allSettled(all.map((f) => f()));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    };
  });

  // Another client (or the server seeding defaults) saved the roster.
  client.events.on("agents.changed", ({ ws, roster }) => {
    if (client.scope && ws !== client.scope) return;
    store.setState({ roster });
  });

  return store;
}
