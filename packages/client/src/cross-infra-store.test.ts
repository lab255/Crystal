import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter, type BridgeEvents, type CrossInfraMap, type CrossInfraOverlay } from "@crystal/core";
import type { BridgeClient, ConnectionState } from "./bridge-client.js";
import { createCrossInfraStore } from "./cross-infra-store.js";

const overlay = (): CrossInfraOverlay => ({
  id: "default",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  envSelection: {},
  pins: {},
  identityLinks: [],
});
const map = (): CrossInfraMap => ({ projects: [], shared: [], generatedAt: "2026-08-23T00:00:00.000Z" });

function mockClient() {
  const events = new Emitter<BridgeEvents & { connection: { state: ConnectionState } }>();
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === "infra.cross") return map();
    if (method === "infra.crossOverlay.get") return { overlay: overlay() };
    if (method === "infra.crossOverlay.save")
      return { overlay: (params as { overlay: CrossInfraOverlay }).overlay };
    throw new Error(`unexpected ${method}`);
  });
  return { client: { events, request } as unknown as BridgeClient, events, request };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("cross infrastructure store", () => {
  it("coalesces optimistic mutations into one debounced save", async () => {
    vi.useFakeTimers();
    const { client, request } = mockClient();
    const store = createCrossInfraStore(client);
    await store.getState().ensure();
    request.mockClear();

    store.getState().setPin("project:a", { x: 1, y: 2 });
    store.getState().setEnvSelection("a", "production");
    await vi.advanceTimersByTimeAsync(300);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("infra.crossOverlay.save", {
      overlay: expect.objectContaining({
        pins: { "project:a": { x: 1, y: 2 } },
        envSelection: { a: "production" },
      }),
    });
    expect(store.getState().dirty).toBe(false);
  });

  it("does not refresh the overlay for layout events while a save is pending", async () => {
    vi.useFakeTimers();
    const { client, events, request } = mockClient();
    const store = createCrossInfraStore(client);
    await store.getState().ensure();
    request.mockClear();

    store.getState().setPin("project:a", { x: 3, y: 4 });
    events.emit("infra.crossChanged", { reason: "layout" });
    await settle();

    expect(request).not.toHaveBeenCalledWith("infra.crossOverlay.get", {});
  });

  it("retains dirty state, records an error, and retries a rejected save once", async () => {
    vi.useFakeTimers();
    const { client, request } = mockClient();
    const store = createCrossInfraStore(client);
    await store.getState().ensure();
    request.mockClear();
    request
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async (_method: string, params: unknown) => ({
        overlay: (params as { overlay: CrossInfraOverlay }).overlay,
      }));

    store.getState().setPin("project:a", { x: 9, y: 8 });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getState()).toMatchObject({ dirty: true, error: "disk full" });
    expect(store.getState().overlay?.pins["project:a"]).toEqual({ x: 9, y: 8 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ dirty: false, error: null });
  });

  it("debounces data-reason map refreshes", async () => {
    vi.useFakeTimers();
    const { client, events, request } = mockClient();
    const store = createCrossInfraStore(client);
    await store.getState().ensure();
    request.mockClear();

    events.emit("infra.crossChanged", { reason: "data" });
    events.emit("infra.crossChanged", { reason: "data" });
    await vi.advanceTimersByTimeAsync(299);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("infra.cross", {});
  });

  it("optimistically adds and removes identity links without clearing them with pins", async () => {
    vi.useFakeTimers();
    const { client, request } = mockClient();
    const store = createCrossInfraStore(client);
    await store.getState().ensure();

    const addedId = store.getState().addIdentityLink(
      [{ ws: "a", key: "ext:db" }, { ws: "b", key: "ext:database" }],
      " Primary DB ",
    );
    const link = store.getState().overlay!.identityLinks[0]!;
    expect(addedId).toBe(link.id);
    expect(link).toMatchObject({ label: "Primary DB", members: [{ ws: "a", key: "ext:db" }, { ws: "b", key: "ext:database" }] });
    await vi.advanceTimersByTimeAsync(300);
    request.mockClear();
    const duplicateId = store.getState().addIdentityLink(
      [{ ws: "b", key: "ext:database" }, { ws: "a", key: "ext:db" }],
      "Ignored replacement label",
    );
    expect(duplicateId).toBe(link.id);
    expect(store.getState().overlay!.identityLinks).toEqual([link]);
    expect(store.getState().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(request).not.toHaveBeenCalled();
    store.getState().setPin("idlink:test", { x: 1, y: 2 });
    store.getState().clearPins();
    expect(store.getState().overlay!.identityLinks).toHaveLength(1);
    store.getState().setPin(`idlink:${link.id}`, { x: 3, y: 4 });
    store.getState().removeIdentityLink(link.id);
    expect(store.getState().overlay!.identityLinks).toEqual([]);
    expect(store.getState().overlay!.pins[`idlink:${link.id}`]).toBeUndefined();
  });
});
