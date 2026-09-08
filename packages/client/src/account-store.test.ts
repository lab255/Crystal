import { Emitter, UNSCOPED_METHODS, type AccountStatus, type BridgeEvents } from "@crystal/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, ConnectionState } from "./bridge-client.js";
import { bindAccount, useAccount } from "./account-store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const signedOut: AccountStatus = { available: true, signedIn: false };
const signedIn: AccountStatus = { available: true, signedIn: true, profile: { sub: "user" } };
const cleanups: (() => void)[] = [];
function client(state: ConnectionState = "open") {
  const events = new Emitter<BridgeEvents & { connection: { state: ConnectionState } }>();
  const request = vi.fn(async () => signedOut);
  return { events, request, state };
}
function bind(fake: ReturnType<typeof client>) {
  const dispose = bindAccount(fake as unknown as BridgeClient);
  cleanups.push(dispose);
  return dispose;
}
afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); });

describe("account store", () => {
  it("hydrates on open, receives events and rehydrates after reconnect", async () => {
    const fake = client("connecting");
    bind(fake);
    expect(fake.request).not.toHaveBeenCalled();
    fake.events.emit("connection", { state: "open" });
    await Promise.resolve();
    expect(fake.request).toHaveBeenCalledWith("account.status", {});
    expect(useAccount.getState().status).toEqual(signedOut);
    fake.events.emit("account.changed", signedIn);
    expect(useAccount.getState().status).toEqual(signedIn);
    fake.events.emit("connection", { state: "closed" });
    expect(useAccount.getState().status).toBeNull();
    fake.events.emit("connection", { state: "open" });
    await Promise.resolve();
    expect(fake.request).toHaveBeenCalledTimes(2);
    expect(useAccount.getState().status).toEqual(signedOut);
  });

  it("does not let a stale status response overwrite a newer change", async () => {
    const fake = client();
    const pending = deferred<AccountStatus>();
    fake.request.mockReturnValue(pending.promise);
    bind(fake);
    fake.events.emit("account.changed", signedIn);
    pending.resolve(signedOut);
    await Promise.resolve();
    expect(useAccount.getState().status).toEqual(signedIn);
  });

  it("disposes subscriptions and ignores old-server replies after switching", async () => {
    const old = client();
    const pending = deferred<AccountStatus>();
    old.request.mockReturnValue(pending.promise);
    const dispose = bind(old);
    dispose();
    bind(client());
    await Promise.resolve();
    pending.resolve(signedIn);
    old.events.emit("account.changed", signedIn);
    await Promise.resolve();
    expect(useAccount.getState().status).toEqual(signedOut);
  });

  it("reports unavailable when an older server rejects hydration", async () => {
    const fake = client();
    fake.request.mockRejectedValue(new Error("unknown method"));
    bind(fake);
    await vi.waitFor(() => expect(useAccount.getState().status).toMatchObject({ available: false, signedIn: false, reason: expect.any(String) }));
  });

  it("keeps all account methods unscoped", () => {
    for (const method of ["account.status", "account.signIn", "account.signOut"] as const) {
      expect(UNSCOPED_METHODS).toContain(method);
    }
  });
});
