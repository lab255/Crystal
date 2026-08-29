import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Emitter,
  countActionableQuestionRows,
  createWorkflow,
  type AgentRun,
  type BridgeEvents,
  type PendingPermission,
  type RunEvent,
  type Workflow,
} from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";
import { createFleetStore } from "./fleet-store.js";
import { parseRunKey, parseWsKey, runKey, sidForEndpoint, wsKey } from "./fleet-client.js";

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

function run(id: string, patch: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    status: "completed",
    createdAt: "2026-08-09T00:00:00.000Z",
    ...patch,
  } as AgentRun;
}

/** A minimal board project holding open/answered questions. */
function projectWith(
  questions: {
    id: string;
    answer?: string;
    runId?: string | null;
    askedBy?: "agent" | "user";
  }[],
) {
  return {
    path: ".crystal/projects/p.crystal",
    project: {
      name: "P",
      tasks: [
        {
          id: "t1",
          title: "Task",
          questions: questions.map((q) => ({
            id: q.id,
            runId: q.runId ?? null,
            askedBy: q.askedBy ?? "agent",
            text: `Q ${q.id}`,
            answer: q.answer ?? null,
            closed: null,
          })),
        },
      ],
    },
  };
}

/** A fake bridge connection: canned request results + a real event emitter. */
function fakeClient(
  data: {
    runsByWs?: Record<string, AgentRun[]>;
    projectsByWs?: Record<string, { path: string; project: unknown }[]>;
    permissionsByWs?: Record<string, PendingPermission[]>;
    workflowsByWs?: Record<string, Workflow[]>;
    eventsByRun?: Record<string, RunEvent[]>;
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
      if (method === "permissions.pending") {
        return Promise.resolve({ pending: data.permissionsByWs?.[params.ws ?? ""] ?? [] });
      }
      if (method === "workflow.list") {
        return Promise.resolve({ workflows: data.workflowsByWs?.[params.ws ?? ""] ?? [] });
      }
      if (method === "agent.events") {
        const runId = (params as { runId?: string }).runId ?? "";
        return Promise.resolve({ events: data.eventsByRun?.[runId] ?? [] });
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

describe("fleet workflows and run events", () => {
  const event = (runId: string, seq: number): RunEvent => ({
    runId,
    seq,
    ts: `2026-08-09T00:00:0${seq}.000Z`,
    event: {
      type: "result",
      ok: true,
      resultText: `event ${seq}`,
      costUsd: null,
      turns: null,
      durationMs: null,
      sessionId: null,
    },
  });

  it("loads workflows, tolerates old servers, and upserts live changes", async () => {
    const first = createWorkflow({ name: "First", goal: "ship" });
    const store = createFleetStore();
    const client = fakeClient({ workflowsByWs: { w1: [first] } });
    store.getState().attach("s1", client);
    await store.getState().refresh("s1", ["w1"]);
    expect(store.getState().workflowsByWs["s1/w1"]).toEqual([first]);

    const changed = { ...first, name: "Changed" };
    client.events.emit("workflow.changed", { ws: "w1", workflow: changed });
    expect(store.getState().workflowsByWs["s1/w1"]![0]!.name).toBe("Changed");

    client.request.mockImplementation((method: string) =>
      method === "workflow.list" ? Promise.reject(new Error("old server")) :
      method === "agent.list" ? Promise.resolve({ runs: [] }) :
      method === "todos.get" ? Promise.resolve({ todos: { items: [] } }) :
      method === "permissions.pending" ? Promise.resolve({ pending: [] }) :
      method === "workspace.get" ? Promise.resolve({ projects: [] }) :
      Promise.reject(new Error(`unexpected ${method}`)),
    );
    await store.getState().refresh("s1", ["w1"]);
    expect(store.getState().workflowsByWs["s1/w1"]![0]!.name).toBe("Changed");
  });

  it("loads complete events, unions by seq, attributes live events, and strips on remove", async () => {
    const store = createFleetStore();
    const client = fakeClient({
      runsByWs: { w1: [run("r1")] },
      eventsByRun: { r1: [event("r1", 1), event("r1", 2)] },
    });
    const detach = store.getState().attach("s1", client);
    await store.getState().refresh("s1", ["w1"]);

    // Unknown and not-yet-loaded runs do not create partial histories.
    client.events.emit("agent.event", event("unknown", 1));
    client.events.emit("agent.event", event("r1", 3));
    expect(store.getState().eventsByRunKey).toEqual({});

    await store.getState().loadRunEvents("s1", "w1", "r1");
    client.events.emit("agent.event", event("r1", 2));
    client.events.emit("agent.event", event("r1", 3));
    expect(store.getState().eventsByRunKey["s1/w1/r1"]!.map((item) => item.seq)).toEqual([1, 2, 3]);
    await store.getState().loadRunEvents("s1", "w1", "r1");
    expect(client.request.mock.calls.filter(([method]) => method === "agent.events")).toHaveLength(1);

    detach();
    expect(store.getState().eventsByRunKey).toEqual({});
  });
});

describe("question details per workspace", () => {
  it("recounts open questions (with task context) on workspace.changed", async () => {
    const store = createFleetStore();
    const client = fakeClient({
      projectsByWs: { w1: [projectWith([{ id: "q1" }, { id: "q2", answer: "done" }])] },
    });
    store.getState().attach("default", client);

    client.events.emit("workspace.changed", { ws: "w1" } as never);
    await vi.advanceTimersByTimeAsync(500); // recount debounce
    const questions = store.getState().questionsByWs["default/w1"]!;
    expect(questions.map((q) => q.question.id)).toEqual(["q1"]); // answered one filtered
    expect(questions[0]!.taskId).toBe("t1");
    expect(questions[0]!.deliverability).toBe("unknown");

    // Same open-question ids → the stored reference must not churn (selector
    // stability + the attention notifier reading recounts as no-ops).
    client.events.emit("workspace.changed", { ws: "w1" } as never);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState().questionsByWs["default/w1"]).toBe(questions);
  });

  it("annotates from the complete run snapshot and preserves references until a verdict changes", async () => {
    const store = createFleetStore();
    const client = fakeClient({
      runsByWs: {
        w1: [run("asking", { sessionId: "session-1" })],
      },
      projectsByWs: {
        w1: [
          projectWith([
            { id: "q-live", runId: "asking" },
            { id: "q-stale", runId: "missing" },
            { id: "q-user", runId: null, askedBy: "user" },
          ]),
        ],
      },
    });
    store.getState().attach("default", client);

    await store.getState().refresh("default", ["w1"]);
    await vi.advanceTimersByTimeAsync(500);
    const annotated = store.getState().questionsByWs["default/w1"]!;
    expect(annotated.map((row) => [row.question.id, row.deliverability])).toEqual([
      ["q-live", "deliverable"],
      ["q-stale", "undeliverable"],
      ["q-user", "undeliverable"],
    ]);
    expect(countActionableQuestionRows(annotated)).toBe(2);

    client.events.emit("agent.runChanged", {
      ws: "w1",
      run: run("asking", { sessionId: "session-1" }),
    } as never);
    expect(store.getState().questionsByWs["default/w1"]).toBe(annotated);

    client.events.emit("agent.runChanged", {
      ws: "w1",
      run: run("asking", { status: "cancelled", sessionId: "session-1" }),
    } as never);
    const changed = store.getState().questionsByWs["default/w1"]!;
    expect(changed).not.toBe(annotated);
    expect(changed.find((row) => row.question.id === "q-live")!.deliverability).toBe(
      "undeliverable",
    );
    expect(countActionableQuestionRows(changed)).toBe(1); // user-authored stays actionable
  });

  it("leaves unread workspaces ABSENT so seeding can tell unknown from empty", async () => {
    const store = createFleetStore();
    const client = fakeClient({ runsByWs: { w1: [run("r1")] } });
    store.getState().attach("default", client);
    await store.getState().refresh("default", ["w1"]);
    // Runs landed, but no recount has read the board yet.
    expect(store.getState().runsByWs["default/w1"]).toBeDefined();
    expect("default/w1" in store.getState().questionsByWs).toBe(false);
  });
});

describe("pending permissions per workspace", () => {
  const permission = (id: string): PendingPermission => ({
    id,
    runId: `run-${id}`,
    tool: "Bash",
    summary: "pnpm test",
    requestedAt: "2026-08-09T00:00:00.000Z",
  });

  it("hydrates permissions and refreshes them on permissions.changed", async () => {
    const data = { permissionsByWs: { w1: [permission("p1")] } };
    const store = createFleetStore();
    const client = fakeClient(data);
    store.getState().attach("default", client);

    await store.getState().refresh("default", ["w1"]);
    expect(store.getState().permissionsByWs["default/w1"]?.map((item) => item.id)).toEqual([
      "p1",
    ]);

    data.permissionsByWs.w1 = [permission("p2"), permission("p3")];
    client.events.emit("permissions.changed", { ws: "w1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().permissionsByWs["default/w1"]?.map((item) => item.id)).toEqual([
      "p2",
      "p3",
    ]);
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
    expect(parseRunKey(runKey("s1", "w1", "r1"))).toEqual({ sid: "s1", ws: "w1", runId: "r1" });
  });

  it("derives a stable, separator-free sid from an endpoint", () => {
    const pipe = String.raw`\\.\pipe\crystal-desktop-1234`;
    const sid = sidForEndpoint(pipe);
    expect(sid).toBe(sidForEndpoint(pipe)); // stable
    expect(sid).toMatch(/^s[0-9a-f]+$/); // no ":" or "/" — safe in refs and keys
    expect(sid).not.toBe(sidForEndpoint("ws://localhost:4517/crystal"));
  });
});
