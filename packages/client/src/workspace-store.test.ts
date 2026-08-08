import { describe, expect, it, vi } from "vitest";
import {
  Emitter,
  createDefaultRoster,
  createProject,
  type BridgeEvents,
  type BridgeMethods,
  type Project,
  type WorkspaceInfo,
} from "@crystal/core";
import { createWorkspaceStore } from "./workspace-store.js";
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

function workspace(id: string, project: Project = createProject(id)): WorkspaceInfo {
  return {
    id,
    root: `/${id}`,
    manifest: { id, name: id, description: "", repos: [] },
    architectures: [],
    archDrafts: [],
    projects: [{ path: ".crystal/projects/board.json", project }],
  };
}

function scopedClient(
  request: (method: string, params: unknown, ws: string | null) => Promise<unknown>,
): BridgeClient & { scope: string | null } {
  return {
    scope: "a",
    events: new Emitter<ClientEvents>(),
    request: vi.fn(function (this: { scope: string | null }, method: string, params: unknown) {
      return request(method, params, this.scope);
    }),
  } as unknown as BridgeClient & { scope: string | null };
}

describe("workspace store", () => {
  it("keeps the newest workspace refresh and scopes subsequent edits to it", async () => {
    const infoA = deferred<WorkspaceInfo>();
    const agentsA = deferred<BridgeMethods["agents.get"]["result"]>();
    const infoB = deferred<WorkspaceInfo>();
    const agentsB = deferred<BridgeMethods["agents.get"]["result"]>();
    const saves: BridgeMethods["project.save"]["params"][] = [];
    const client = scopedClient(async (method, params, ws) => {
      if (method === "workspace.get") return ws === "a" ? infoA.promise : infoB.promise;
      if (method === "agents.get") return ws === "a" ? agentsA.promise : agentsB.promise;
      if (method === "project.save") {
        saves.push(params as BridgeMethods["project.save"]["params"]);
        return { ok: true };
      }
      throw new Error(`unexpected bridge call: ${method}`);
    });
    const store = createWorkspaceStore(client);

    const refreshA = store.getState().refresh();
    client.scope = "b";
    const refreshB = store.getState().refresh();
    const projectB = createProject("B");
    infoB.resolve(workspace("b", projectB));
    agentsB.resolve({ roster: createDefaultRoster() });
    await refreshB;
    infoA.resolve(workspace("a"));
    agentsA.resolve({ roster: createDefaultRoster() });
    await refreshA;

    expect(store.getState().info?.id).toBe("b");
    const edited = { ...projectB, description: "edited in B" };
    store.getState().updateProject(".crystal/projects/board.json", edited);
    await store.getState().flush();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ ws: "b", project: edited });
  });

  it("persists a debounced edit to the workspace captured when it was scheduled", async () => {
    const saves: BridgeMethods["project.save"]["params"][] = [];
    const client = scopedClient(async (method, params) => {
      if (method === "project.save") {
        saves.push(params as BridgeMethods["project.save"]["params"]);
        return { ok: true };
      }
      throw new Error(`unexpected bridge call: ${method}`);
    });
    const store = createWorkspaceStore(client);
    const projectA = createProject("A");
    store.setState({ info: workspace("a", projectA) });
    const editedA = { ...projectA, description: "edited in A" };

    store.getState().updateProject(".crystal/projects/board.json", editedA);
    client.scope = "b";
    const projectB = createProject("B");
    const editedB = { ...projectB, description: "edited in B" };
    store.setState({ info: workspace("b", projectB) });
    store.getState().updateProject(".crystal/projects/board.json", editedB);
    await store.getState().flush();

    expect(saves).toHaveLength(2);
    expect(saves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ws: "a", project: editedA }),
        expect.objectContaining({ ws: "b", project: editedB }),
      ]),
    );
  });

  it("keeps failed saves dirty and retries them on the next flush", async () => {
    let healthy = false;
    const save = vi.fn(async () => {
      if (!healthy) throw new Error("disk unavailable");
      return { ok: true as const };
    });
    const client = scopedClient(async (method) => {
      if (method === "project.save") return save();
      throw new Error(`unexpected bridge call: ${method}`);
    });
    const store = createWorkspaceStore(client);
    const path = ".crystal/projects/board.json";
    const project = createProject("A");
    store.setState({ info: workspace("a", project) });
    store.getState().updateProject(path, { ...project, description: "dirty" });

    await expect(store.getState().flush()).rejects.toThrow("disk unavailable");
    expect(store.getState().pendingSaves[path]).toBe(true);
    expect(store.getState().failedSaves[path]).toBe(true);

    healthy = true;
    await store.getState().flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingSaves[path]).toBeUndefined();
    expect(store.getState().failedSaves[path]).toBeUndefined();
  });
});
