import { describe, expect, it, vi } from "vitest";
import {
  Emitter,
  createAgentRun,
  type AgentRun,
  type BridgeEvents,
  type BridgeMethods,
} from "@crystal/core";
import { createAgentStore } from "./agent-store.js";
import type { BridgeClient, ConnectionState } from "./bridge-client.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ClientEvents = BridgeEvents & { connection: { state: ConnectionState } };

function run(id: string): AgentRun {
  return { ...createAgentRun({ prompt: id }), id };
}

function scopedClient(
  request: (method: string, ws: string | null) => Promise<unknown>,
): BridgeClient & { scope: string | null } {
  return {
    scope: "a",
    events: new Emitter<ClientEvents>(),
    request: vi.fn(function (this: { scope: string | null }, method: string) {
      return request(method, this.scope);
    }),
  } as unknown as BridgeClient & { scope: string | null };
}

describe("agent store scope", () => {
  it("keeps the newest workspace run list when refreshes resolve out of order", async () => {
    const a = deferred<BridgeMethods["agent.list"]["result"]>();
    const b = deferred<BridgeMethods["agent.list"]["result"]>();
    const client = scopedClient(async (method, ws) => {
      if (method === "agent.list") return ws === "a" ? a.promise : b.promise;
      throw new Error(`unexpected bridge call: ${method}`);
    });
    const store = createAgentStore(client);

    const refreshA = store.getState().refresh();
    client.scope = "b";
    const refreshB = store.getState().refresh();
    b.resolve({ runs: [run("b")], auth: { broken: false, detail: null } });
    await refreshB;
    a.resolve({ runs: [run("a")], auth: { broken: false, detail: null } });
    await refreshA;

    expect(store.getState().runs.map((item) => item.id)).toEqual(["b"]);
  });

  it("returns but does not commit a start response from the workspace left behind", async () => {
    const started = deferred<BridgeMethods["agent.start"]["result"]>();
    const client = scopedClient(async (method) => {
      if (method === "agent.start") return started.promise;
      throw new Error(`unexpected bridge call: ${method}`);
    });
    const store = createAgentStore(client);
    const pending = store.getState().start({ prompt: "from A" });
    client.scope = "b";
    store.setState({ runs: [run("b")] });
    const runA = run("a");
    started.resolve({ run: runA });

    await expect(pending).resolves.toEqual(runA);
    expect(store.getState().runs.map((item) => item.id)).toEqual(["b"]);
  });
});
