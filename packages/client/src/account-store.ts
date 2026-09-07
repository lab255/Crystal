import type { AccountStatus } from "@crystal/core";
import { create } from "zustand";
import type { BridgeClient } from "./bridge-client.js";

export const useAccount = create<{ status: AccountStatus | null }>(() => ({ status: null }));

/** Follow only the active server, rejecting stale hydration replies after events/switches. */
export function bindAccount(client: BridgeClient): () => void {
  let disposed = false;
  let revision = 0;
  useAccount.setState({ status: null });
  const hydrate = () => {
    const requestRevision = ++revision;
    void client.request("account.status", {}).then((status) => {
      if (!disposed && revision === requestRevision) useAccount.setState({ status });
    }).catch(() => {
      if (!disposed && revision === requestRevision) useAccount.setState({ status: {
        available: false, signedIn: false, reason: "Account status is unavailable on this bridge server.",
      } });
    });
  };
  const offChanged = client.events.on("account.changed", (status) => {
    ++revision;
    useAccount.setState({ status });
  });
  const offConnection = client.events.on("connection", ({ state }) => {
    ++revision;
    useAccount.setState({ status: null });
    if (state === "open") hydrate();
  });
  if (client.state === "open") hydrate();
  return () => {
    disposed = true;
    offChanged();
    offConnection();
    useAccount.setState({ status: null });
  };
}
