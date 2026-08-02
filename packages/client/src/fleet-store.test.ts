import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter, type AgentRun, type BridgeEvents } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";
import { createFleetStore } from "./fleet-store.js";
import { parseWsKey, sidForEndpoint, wsKey } from "./fleet-client.js";

/**
 * The fleet store is the one cross-server aggregate: maps keyed by the
 * compound `"<sid>/<wsId>"`, fed by N attached connections. The invariants
 * under test: a per-connection refresh must never rebuild (or drop) another
 * server's slice, events land under their own connection's keys, and the
 * persisted seen map migrates legacy bare-wsId entries to the default
 * server's compound keys exactly once.
 */

/** Minimal in-memory localStorage (vitest runs in a node environment). */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

function run(id: string): AgentRun {
  return { id, status: "completed" } as unknown as AgentRun;
}

/** A fake bridge connection: canned request results + a real event emitter. */
function fakeClient(
  data: {
    runsByWs?: Record<string, AgentRun[]>;
    projectsByWs?: Record<string, { path: string; project: unknown }[]>;
  } = {},
) {
  const events = new Emitter<BridgeEvents & { connection: { state: string } }>();
  const client = {
    events,
    request: vi.fn((method: string, params: { ws?: string }) => {
      if (method === "agent.list") {
        return Promise.resolve({ runs: data.runsByWs?.[params.ws ?? ""] ?? [] });
      }
      if (method === "todos.get") return Promise.resolve({ todos: { items: [] } });
      if (method === "todos.save") return Promise.resolve({ ok: true });
      if (method === "workspace.get") {
        return Promise.resolve({ projects: data.projectsByWs?.[params.ws ?? ""] ?? [] });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    }),
  };
  return client as unknown as BridgeClient & { request: ReturnType<typeof vi.fn> };
}

const g = globalThis as { localStorage?: unknown };
let storage: FakeStorage;

beforeEach(() => {
  vi.useFakeTimers();
  storage = new FakeStorage();
  g.localStorage = storage;
});

afterEach(() => {
  vi.useRealTimers();
  delete g.localStorage;
});

describe("fleet-store compound keys", () => {
  it("refreshes one connection without touching another's slice", async () => {
    const store = createFleetStore();
    const a = fakeClient({ runsByWs: { w1: [run("a1")], w2: [run("a2")] } });
    const b = fakeClient({ runsByWs: { w1: [run("b1")] } });
    store.getState().attach("default", a);
    store.getState().attach("s2", b);

    await store.getState().refresh("default", ["w1", "w2"]);
    await store.getState().refresh("s2", ["w1"]);
    expect(Object.keys(store.getState().runsByWs).sort()).toEqual([
      "default/w1",
      "default/w2",
      "s2/w1",
    ]);
    // Same wsId on two servers stays two entries — the whole point of the key.
    expect(store.getState().runsByWs["default/w1"]![0]!.id).toBe("a1");
    expect(store.getState().runsByWs["s2/w1"]![0]!.id).toBe("b1");

    // Server A closes w1: only A's slice is rebuilt; B's w1 must survive.
    await store.getState().refresh("default", ["w2"]);
    expect(Object.keys(store.getState().runsByWs).sort()).toEqual(["default/w2", "s2/w1"]);
  });

  it("routes events to their own connection's keys", () => {
    const store = createFleetStore();
    const a = fakeClient();
    const b = fakeClient();
    store.getState().attach("default", a);
    store.getState().attach("s2", b);

    b.events.emit("agent.runChanged", { ws: "w1", run: run("b-run") } as never);
    expect(store.getState().runsByWs["s2/w1"]![0]!.id).toBe("b-run");
    expect(store.getState().runsByWs["default/w1"]).toBeUndefined();
  });

  it("drops a removed connection's slice (and only it) on detach", async () => {
    const store = createFleetStore();
    const a = fakeClient({ runsByWs: { w1: [run("a1")] } });
    const b = fakeClient({ runsByWs: { w1: [run("b1")] } });
    store.getState().attach("default", a);
    const detachB = store.getState().attach("s2", b);
    await store.getState().refresh("default", ["w1"]);
    await store.getState().refresh("s2", ["w1"]);

    detachB();
    expect(Object.keys(store.getState().runsByWs)).toEqual(["default/w1"]);
    // Detached connections no longer feed events.
    b.events.emit("agent.runChanged", { ws: "w9", run: run("ghost") } as never);
    expect(store.getState().runsByWs["s2/w9"]).toBeUndefined();
  });

  it("stores board snapshots per workspace via the debounced recount", async () => {
    const store = createFleetStore();
    const board = { path: ".crystal/projects/q3.crystal", project: { name: "Q3", tasks: [] } };
    const a = fakeClient({ projectsByWs: { w1: [board] } });
    store.getState().attach("default", a);

    a.events.emit("workspace.changed", { ws: "w1" } as never);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState().projectsByWs["default/w1"]).toEqual([board]);

    // A refresh that no longer lists w1 drops its boards with the rest.
    await store.getState().refresh("default", []);
    expect(store.getState().projectsByWs["default/w1"]).toBeUndefined();
  });

  it("marks seen under the compound key and persists it", () => {
    const store = createFleetStore();
    store.getState().markSeen(wsKey("s2", "w1"));
    expect(store.getState().seenAtByWs["s2/w1"]).toBeTruthy();
    const persisted = JSON.parse(storage.getItem("crystal.seenRuns")!) as Record<string, string>;
    expect(persisted["s2/w1"]).toBeTruthy();
  });
});

describe("crystal.seenRuns migration", () => {
  it("migrates legacy bare-wsId keys to the default server's compound keys", () => {
    storage.setItem(
      "crystal.seenRuns",
      JSON.stringify({
        abc123: "2026-01-01T00:00:00.000Z", // pre-fleet entry
        "s2/def456": "2026-02-02T00:00:00.000Z", // already compound
        broken: 42, // junk values are dropped
      }),
    );
    const store = createFleetStore();
    expect(store.getState().seenAtByWs).toEqual({
      "default/abc123": "2026-01-01T00:00:00.000Z",
      "s2/def456": "2026-02-02T00:00:00.000Z",
    });
    // One-way: the migrated payload is persisted back immediately, so the
    // next load sees only compound keys.
    const persisted = JSON.parse(storage.getItem("crystal.seenRuns")!) as Record<string, string>;
    expect(Object.keys(persisted).sort()).toEqual(["default/abc123", "s2/def456"]);
  });

  it("leaves an already-migrated payload untouched", () => {
    const payload = { "default/abc123": "2026-01-01T00:00:00.000Z" };
    storage.setItem("crystal.seenRuns", JSON.stringify(payload));
    const store = createFleetStore();
    expect(store.getState().seenAtByWs).toEqual(payload);
  });
});

describe("fleet key + sid helpers", () => {
  it("round-trips compound keys", () => {
    expect(parseWsKey(wsKey("s1a2b3c4", "abc"))).toEqual({ sid: "s1a2b3c4", ws: "abc" });
    expect(parseWsKey("bare")).toEqual({ sid: "default", ws: "bare" });
  });

  it("derives a stable, separator-free sid from an endpoint", () => {
    const pipe = String.raw`\\.\pipe\crystal-desktop-1234`;
    const sid = sidForEndpoint(pipe);
    expect(sid).toBe(sidForEndpoint(pipe)); // stable
    expect(sid).toMatch(/^s[0-9a-f]+$/); // no ":" or "/" — safe in refs and keys
    expect(sid).not.toBe(sidForEndpoint("ws://localhost:4517/crystal"));
  });
});
