import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileSchema, createDefaultRoster } from "@crystal/core";
import { AgentLibrary, GlobalAgentStore } from "./agent-library.js";
import { WorkspaceStore } from "./workspace-store.js";

let tmp: string | null = null;

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = null;
});

async function makeFixture() {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-agent-lib-"));
  const root = path.join(tmp, "root");
  await fs.mkdir(root, { recursive: true });
  const globalDir = path.join(tmp, "global-agents");
  const store = new WorkspaceStore(root);
  const global = new GlobalAgentStore(globalDir);
  const library = new AgentLibrary(store, global);
  return { root, globalDir, store, global, library };
}

const profile = (id: string, name = id) =>
  AgentProfileSchema.parse({ id, name, kind: "generic", model: "sonnet" });

describe("AgentLibrary", () => {
  it("merges project then library, project winning on id conflict", async () => {
    const { store, global, library } = await makeFixture();
    await store.saveAgents({
      ...createDefaultRoster(),
      agents: [profile("agent_shared", "Project copy"), profile("agent_own")],
    });
    await global.save(profile("agent_shared", "Library copy"));
    await global.save(profile("agent_lib"));

    const roster = await library.roster();
    const byId = new Map(roster.agents.map((a) => [a.id, a]));
    // Directory (file) decides scope, whatever the records claimed.
    expect(byId.get("agent_own")?.scope).toBe("project");
    expect(byId.get("agent_lib")?.scope).toBe("library");
    // One entry for the conflicted id — the project's.
    expect(roster.agents.filter((a) => a.id === "agent_shared")).toHaveLength(1);
    expect(byId.get("agent_shared")?.name).toBe("Project copy");
    expect((await library.get("agent_shared"))?.name).toBe("Project copy");
    expect((await library.get("agent_lib"))?.scope).toBe("library");
    expect(await library.get("nope")).toBeNull();
  });

  it("re-stamps scope from the directory a record was found in", async () => {
    const { globalDir, library } = await makeFixture();
    // A file copied into the library while claiming to be a project profile
    // must still read as library — the persisted field is display data.
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, "agent_liar.json"),
      JSON.stringify({ ...profile("agent_liar"), scope: "project" }),
      "utf8",
    );
    expect((await library.get("agent_liar"))?.scope).toBe("library");
  });

  it("saveProfile with a different scope MOVES the record between stores", async () => {
    const { store, global, library } = await makeFixture();
    await store.saveAgents({ ...createDefaultRoster(), agents: [profile("agent_x")] });

    // project → library: the project file must lose its copy.
    const saved = await library.saveProfile(profile("agent_x"), "library");
    expect(saved.scope).toBe("library");
    expect((await store.loadAgents()).agents.some((a) => a.id === "agent_x")).toBe(false);
    expect((await global.get("agent_x"))?.id).toBe("agent_x");

    // library → project: the global file must go away too.
    const back = await library.saveProfile(saved, "project");
    expect(back.scope).toBe("project");
    expect(await global.get("agent_x")).toBeUndefined();
    expect((await store.loadAgents()).agents.some((a) => a.id === "agent_x")).toBe(true);
    // Still exactly one entry in the merged view.
    expect((await library.roster()).agents.filter((a) => a.id === "agent_x")).toHaveLength(1);
  });

  it("saveProfile without a scope updates the record where it lives", async () => {
    const { global, library } = await makeFixture();
    await global.save(profile("agent_lib", "Old name"));
    const saved = await library.saveProfile({ ...profile("agent_lib", "New name") });
    expect(saved.scope).toBe("library");
    expect((await global.get("agent_lib"))?.name).toBe("New name");
    // A brand-new profile (blank id) defaults to the project and mints an id.
    const fresh = await library.saveProfile({ ...profile("x"), id: "" });
    expect(fresh.id).toMatch(/^agent/);
    expect(fresh.scope).toBe("project");
  });

  it("saveRoster keeps roster fields but never clobbers library profiles", async () => {
    const { store, global, library } = await makeFixture();
    await global.save(profile("agent_lib"));
    const merged = await library.roster();
    // A client echoing the merged view back with new roster-level fields.
    await library.saveRoster({ ...merged, managerAgentId: "agent_lib", defaultHuman: "eliot" });
    const onDisk = await store.loadAgents();
    expect(onDisk.managerAgentId).toBe("agent_lib");
    expect(onDisk.defaultHuman).toBe("eliot");
    // The library profile stayed in the library — not copied into the repo file.
    expect(onDisk.agents.some((a) => a.id === "agent_lib")).toBe(false);
    expect((await library.roster()).agents.filter((a) => a.id === "agent_lib")).toHaveLength(1);
  });

  it("removeProfile refuses the default agent, removes from either scope", async () => {
    const { store, global, library } = await makeFixture();
    const roster = createDefaultRoster();
    await store.saveAgents({ ...roster, managerAgentId: "agent_specialist" });
    await global.save(profile("agent_lib"));

    await expect(library.removeProfile(roster.defaultAgentId!)).rejects.toThrow(/default/);
    await library.removeProfile("agent_specialist");
    const after = await store.loadAgents();
    expect(after.agents.some((a) => a.id === "agent_specialist")).toBe(false);
    // A removed profile cannot stay named as the manager.
    expect(after.managerAgentId).toBeNull();
    await library.removeProfile("agent_lib");
    expect(await global.get("agent_lib")).toBeUndefined();
    await expect(library.removeProfile("agent_lib")).rejects.toThrow(/Unknown/);
  });

  it("announces global saves to every workspace library", async () => {
    const { global, library } = await makeFixture();
    const other = new AgentLibrary(
      { loadAgents: async () => createDefaultRoster(), saveAgents: async () => {} },
      global,
    );
    let changes = 0;
    other.events.on("changed", () => (changes += 1));
    await library.saveProfile(profile("agent_lib"), "library");
    expect(changes).toBe(1);
    // Disposed libraries stop forwarding — the reopened-workspace leak.
    other.dispose();
    await global.save(profile("agent_lib2"));
    expect(changes).toBe(1);
  });
});
