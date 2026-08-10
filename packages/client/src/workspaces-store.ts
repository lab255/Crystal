import { createStore, type StoreApi } from "zustand/vanilla";
import type { RecentWorkspace, WorkspaceDescriptor } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * The set of workspaces open on the bridge server, plus which one this UI is
 * focused on. Switching `activeId` re-scopes the bridge client; the provider
 * reacts by refreshing the workspace/agent stores.
 */
export interface WorkspacesState {
  workspaces: WorkspaceDescriptor[];
  /** Server-side reopen list, most recent first (includes open workspaces). */
  recents: RecentWorkspace[];
  /**
   * Safe mode: roots the server held back because the previous boot's restore
   * never completed (it most likely crashed opening one of them). Non-null
   * means the shell should prompt to restore or start without.
   */
  pendingRestore: string[] | null;
  activeId: string | null;
  error: string | null;

  refresh(): Promise<void>;
  /** Open a workspace by absolute path on the host and switch to it. */
  openWorkspace(root: string): Promise<WorkspaceDescriptor>;
  closeWorkspace(id: string): Promise<void>;
  /** Safe mode "restore anyway": reopen the held-back roots. */
  restorePending(): Promise<void>;
  /** Safe mode "start without": drop the held-back roots (they stay in recents). */
  dismissRestore(): Promise<void>;
  setActive(id: string): void;
}

export type WorkspacesStore = StoreApi<WorkspacesState>;

export function createWorkspacesStore(client: BridgeClient): WorkspacesStore {
  const store = createStore<WorkspacesState>((set, get) => ({
    workspaces: [],
    recents: [],
    pendingRestore: null,
    activeId: null,
    error: null,

    async refresh() {
      try {
        const { workspaces, defaultWs, recents, pendingRestore } = await client.request(
          "workspaces.list",
          {},
        );
        const activeId = get().activeId;
        const stillOpen = activeId != null && workspaces.some((w) => w.id === activeId);
        set({
          workspaces,
          recents: recents ?? [],
          pendingRestore: pendingRestore?.length ? pendingRestore : null,
          // No workspaces open (first launch) → no active one; the shell's
          // Overview and its picker are the whole UI until one is opened.
          activeId: stillOpen ? activeId : (defaultWs ?? null),
          error: null,
        });
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    async openWorkspace(root) {
      const { workspace } = await client.request("workspaces.open", { root });
      set((s) => ({
        workspaces: s.workspaces.some((w) => w.id === workspace.id)
          ? s.workspaces
          : [...s.workspaces, workspace],
        activeId: workspace.id,
        error: null,
      }));
      return workspace;
    },

    async closeWorkspace(id) {
      await client.request("workspaces.close", { ws: id });
      set((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id);
        return {
          workspaces,
          activeId: s.activeId === id ? (workspaces[0]?.id ?? null) : s.activeId,
        };
      });
    },

    async restorePending() {
      await client.request("workspaces.restorePending", {});
      await get().refresh();
    },

    async dismissRestore() {
      await client.request("workspaces.dismissRestore", {});
      await get().refresh();
    },

    setActive(id) {
      if (get().activeId !== id && get().workspaces.some((w) => w.id === id)) {
        set({ activeId: id });
      }
    },
  }));

  // Server-side changes to the open set (another client, a rename) sync in.
  client.events.on("workspaces.changed", () => void store.getState().refresh());

  return store;
}
