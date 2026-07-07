import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  ArchDraft,
  ArchitectureGraph,
  Project,
  WorkspaceInfo,
  WorkspaceManifest,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

export interface WorkspaceState {
  info: WorkspaceInfo | null;
  loading: boolean;
  error: string | null;
  /** Paths with unsaved (debounced, in-flight) changes. */
  pendingSaves: Record<string, boolean>;

  refresh(): Promise<void>;
  saveManifest(manifest: WorkspaceManifest): Promise<void>;
  /** Optimistically update + debounce-persist an architecture graph. */
  updateArchitecture(path: string, graph: ArchitectureGraph): void;
  createArchitecture(name: string): Promise<{ path: string; graph: ArchitectureGraph }>;
  deleteArchitecture(path: string): Promise<void>;
  /** Optimistically update + debounce-persist an architecture draft. */
  updateArchDraft(path: string, draft: ArchDraft): void;
  createArchDraft(draft: ArchDraft): Promise<{ path: string; draft: ArchDraft }>;
  /** Server-side: snapshot a git ref's code architecture into a review draft. */
  createArchDraftFromRef(
    archPath: string,
    ref: string,
    repoPath?: string,
  ): Promise<{ path: string; draft: ArchDraft }>;
  deleteArchDraft(path: string): Promise<void>;
  /** Optimistically update + debounce-persist a project board. */
  updateProject(path: string, project: Project): void;
  createProject(name: string): Promise<{ path: string; project: Project }>;
  /** Flush all debounced saves immediately. */
  flush(): Promise<void>;
}

const SAVE_DEBOUNCE_MS = 700;

export type WorkspaceStore = StoreApi<WorkspaceState>;

export function createWorkspaceStore(client: BridgeClient): WorkspaceStore {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushers = new Map<string, () => Promise<void>>();

  const store = createStore<WorkspaceState>((set, get) => {
    function schedule(path: string, save: () => Promise<void>): void {
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      set((s) => ({ pendingSaves: { ...s.pendingSaves, [path]: true } }));
      const doSave = async () => {
        timers.delete(path);
        flushers.delete(path);
        try {
          await save();
        } catch (err) {
          set({ error: (err as Error).message });
        } finally {
          set((s) => {
            const { [path]: _, ...rest } = s.pendingSaves;
            return { pendingSaves: rest };
          });
        }
      };
      flushers.set(path, doSave);
      timers.set(
        path,
        setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS),
      );
    }

    return {
      info: null,
      loading: false,
      error: null,
      pendingSaves: {},

      async refresh() {
        set({ loading: true });
        try {
          const info = await client.request("workspace.get", {});
          set({ info, loading: false, error: null });
        } catch (err) {
          set({ loading: false, error: (err as Error).message });
        }
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
        schedule(path, async () => {
          const latest = get().info?.architectures.find((a) => a.path === path);
          if (latest) await client.request("arch.save", { ws, path, graph: latest.graph });
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
        schedule(path, async () => {
          const latest = get().info?.archDrafts.find((d) => d.path === path);
          if (latest) await client.request("archdraft.save", { ws, path, draft: latest.draft });
        });
      },

      async createArchDraft(draft) {
        const created = await client.request("archdraft.create", { draft });
        const info = get().info;
        if (info) set({ info: { ...info, archDrafts: [...info.archDrafts, created] } });
        return created;
      },

      async createArchDraftFromRef(archPath, ref, repoPath) {
        const created = await client.request("archdraft.fromRef", { archPath, ref, repoPath });
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
        schedule(path, async () => {
          const latest = get().info?.projects.find((p) => p.path === path);
          if (latest) await client.request("project.save", { ws, path, project: latest.project });
        });
      },

      async createProject(name) {
        const created = await client.request("project.create", { name });
        const info = get().info;
        if (info) set({ info: { ...info, projects: [...info.projects, created] } });
        return created;
      },

      async flush() {
        const all = [...flushers.values()];
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        flushers.clear();
        await Promise.all(all.map((f) => f()));
      },
    };
  });

  return store;
}
