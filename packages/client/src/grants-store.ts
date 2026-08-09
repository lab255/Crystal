import { createStore, type StoreApi } from "zustand/vanilla";
import type { GrantsLedger } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

/**
 * The active workspace's grants ledger: tool patterns granted to every agent
 * run, plus the permission-denial tally ("run X requested tool Y, denied N
 * times"). Refreshed on scope changes by the provider; live through
 * `grants.changed` pushes — a denial recorded server-side shows up in the IDE
 * without a round-trip.
 */
export interface GrantsState {
  ledger: GrantsLedger | null;

  refresh(): Promise<void>;
  /** Replace the granted tool list (denials are recorded, not edited). */
  setTools(tools: string[]): Promise<void>;
  /** Flip allow-all mode (broker auto-approves every headless prompt). */
  setAllowAll(on: boolean): Promise<void>;
}

export type GrantsStore = StoreApi<GrantsState>;

export function createGrantsStore(client: BridgeClient): GrantsStore {
  const store = createStore<GrantsState>((set) => ({
    ledger: null,

    async refresh() {
      const { ledger } = await client.request("grants.get", {});
      set({ ledger });
    },

    async setTools(tools) {
      const { ledger } = await client.request("grants.setTools", { tools });
      set({ ledger });
    },

    async setAllowAll(on) {
      const { ledger } = await client.request("grants.setAllowAll", { on });
      set({ ledger });
    },
  }));

  client.events.on("grants.changed", ({ ws, ledger }) => {
    if (client.scope && ws !== client.scope) return;
    store.setState({ ledger });
  });

  return store;
}
