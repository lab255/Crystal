import { createStore, type StoreApi } from "zustand/vanilla";
import type { PendingPermission } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/** Stable empty value for zustand v5 selectors and unloaded workspaces. */
export const EMPTY_PENDING_PERMISSIONS: PendingPermission[] = [];

/** The active workspace's tool calls currently waiting on an owner decision. */
export interface PermissionsState {
  pending: PendingPermission[];

  refresh(): Promise<void>;
  decide(
    id: string,
    decision: "allow" | "deny",
    alwaysAllow?: boolean,
  ): Promise<boolean>;
}

export type PermissionsStore = StoreApi<PermissionsState>;

export function createPermissionsStore(client: BridgeClient): PermissionsStore {
  const store = createStore<PermissionsState>((set) => ({
    pending: EMPTY_PENDING_PERMISSIONS,

    async refresh() {
      const { pending } = await client.request("permissions.pending", {});
      set({ pending });
    },

    async decide(id, decision, alwaysAllow) {
      const result = await client.request("permissions.decide", {
        id,
        decision,
        ...(alwaysAllow ? { alwaysAllow: true } : {}),
      });
      // A timeout or another decision can win between click and request. Its
      // changed push normally clears the row; refetch also closes a missed race.
      if (!result.ok) await store.getState().refresh();
      return result.ok;
    },
  }));

  client.events.on("permissions.changed", ({ ws }) => {
    if (client.scope && ws !== client.scope) return;
    void store.getState().refresh();
  });

  return store;
}
