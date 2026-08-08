import { describe, expect, it, vi } from "vitest";
import {
  ARCH_OVERLAY_FILE,
  Emitter,
  createArchOverlay,
  type BridgeEvents,
} from "@crystal/core";
import { subscribeToArchOverlayChanges } from "./provider.js";
import { createWorkspaceStore } from "./workspace-store.js";
import type { BridgeClient, ConnectionState } from "./bridge-client.js";

type ClientEvents = BridgeEvents & { connection: { state: ConnectionState } };

describe("architecture overlay events", () => {
  it("refetches the active overlay unless a local overlay save is pending", async () => {
    const events = new Emitter<ClientEvents>();
    const getOverlay = vi.fn(async () => ({ overlay: createArchOverlay() }));
    const client = {
      scope: "a",
      events,
      request: vi.fn(async (method: string) => {
        if (method === "arch.getOverlay") return getOverlay();
        if (method === "arch.saveOverlay") return { ok: true };
        throw new Error(`unexpected bridge call: ${method}`);
      }),
    } as unknown as BridgeClient;
    const store = createWorkspaceStore(client);
    store.setState({
      info: {
        id: "a",
        root: "/a",
        manifest: { id: "a", name: "A", description: "", repos: [] },
        architectures: [],
        archDrafts: [],
        projects: [],
      },
      archOverlay: createArchOverlay(),
    });
    const dispose = subscribeToArchOverlayChanges(client, store, () => "a");

    events.emit("arch.overlayChanged", { ws: "a" });
    await vi.waitFor(() => expect(getOverlay).toHaveBeenCalledTimes(1));

    store.getState().updateArchOverlay(createArchOverlay());
    expect(store.getState().pendingSaves[ARCH_OVERLAY_FILE]).toBe(true);
    events.emit("arch.overlayChanged", { ws: "a" });
    await Promise.resolve();
    expect(getOverlay).toHaveBeenCalledTimes(1);

    await store.getState().flush();
    dispose();
  });
});
