import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentProfileSchema,
  AgentRosterSchema,
  Emitter,
  uid,
  type AgentProfile,
  type AgentProfileScope,
  type AgentRoster,
} from "@crystal/core";
import type { WorkspaceStore } from "./workspace-store.js";

/**
 * Where agent profiles live, in the two scopes a user can author into —
 * the same two-scope, directory-decides pattern as the workflow template
 * library (`template-library.ts`), and for the same reasons: wholesale saves
 * from one editor, no read-modify-write races, so no {@link JsonRecordStore}.
 *
 *  - **project** profiles stay inside `.crystal/agents.json` (repo-versioned —
 *    a team's agents travel with the repo), together with the roster wrapper
 *    (`defaultAgentId`, `managerAgentId`, `defaultHuman`): defaults are
 *    workspace policy, not profile data.
 *  - **library** profiles are one JSON file each under `~/.crystal/agents`,
 *    shared by every project on this machine via one {@link GlobalAgentStore}
 *    per server (held by the registry), announced across workspaces on save.
 *
 * Merging rule everywhere: project wins on id conflict, and saving a profile
 * with a different scope **moves** it — one id must never live in both stores,
 * or `get` would resolve it by lookup order instead of by what the user chose.
 */

/** A directory of profile JSON files, loaded once and kept in memory. */
class ProfileDir {
  private profiles = new Map<string, AgentProfile>();
  private loading: Promise<void> | null = null;

  constructor(readonly dir: string) {}

  ensureLoaded(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
        // The directory is the authority on scope, not the record's own
        // field: a file copied here from a project would otherwise keep
        // claiming to be a project profile and be saved back to the wrong
        // place (same rule as TemplateDir).
        const profile = AgentProfileSchema.parse({ ...raw, scope: "library" });
        this.profiles.set(profile.id, profile);
      } catch (err) {
        console.warn(`[crystal] skipping unreadable agent profile ${name}:`, (err as Error).message);
      }
    }
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  async save(profile: AgentProfile): Promise<AgentProfile> {
    const stored: AgentProfile = { ...profile, scope: "library" };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      path.join(this.dir, `${stored.id}.json`),
      JSON.stringify(stored, null, 2),
      "utf8",
    );
    this.profiles.set(stored.id, stored);
    return stored;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.profiles.delete(id)) return false;
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

/**
 * The machine-wide agent-profile library. One instance per server: two open
 * workspaces share these profiles, so a save in either must be visible — and
 * announced — in both. Workspace libraries subscribe to {@link events}; the
 * hub resolves manager agent ids straight against this store.
 */
export class GlobalAgentStore {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private readonly dir: ProfileDir;

  constructor(dir: string) {
    this.dir = new ProfileDir(dir);
  }

  async list(): Promise<AgentProfile[]> {
    await this.dir.ensureLoaded();
    return this.dir.list();
  }

  async get(id: string): Promise<AgentProfile | undefined> {
    await this.dir.ensureLoaded();
    return this.dir.get(id);
  }

  async save(profile: AgentProfile): Promise<AgentProfile> {
    await this.dir.ensureLoaded();
    const saved = await this.dir.save(profile);
    this.events.emit("changed", {});
    return saved;
  }

  async remove(id: string): Promise<boolean> {
    await this.dir.ensureLoaded();
    const removed = await this.dir.remove(id);
    if (removed) this.events.emit("changed", {});
    return removed;
  }
}

/**
 * One workspace's view of the agents it can dispatch to: the project roster
 * (still `.crystal/agents.json`, via the workspace store) merged with the
 * shared library. All roster reads and writes go through here so the two
 * halves can never drift — the bridge's `agents.*` handlers are thin wrappers.
 */
export class AgentLibrary {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private readonly disposeGlobal: () => void;

  constructor(
    private readonly store: Pick<WorkspaceStore, "loadAgents" | "saveAgents">,
    private readonly global: GlobalAgentStore,
  ) {
    // A library save from another workspace changes this one's roster too.
    this.disposeGlobal = this.global.events.on("changed", () => this.events.emit("changed", {}));
  }

  /** Detach from the shared store (workspace close) — same leak TemplateLibrary plugs. */
  dispose(): void {
    this.disposeGlobal();
  }

  /**
   * The merged roster: project profiles first (scope re-stamped — the file
   * they came from decides, not the persisted field), then library profiles
   * not shadowed by a project id.
   */
  async roster(): Promise<AgentRoster> {
    const roster = await this.store.loadAgents();
    const project = roster.agents.map(
      (a): AgentProfile => ({ ...a, scope: "project" }),
    );
    const ids = new Set(project.map((a) => a.id));
    const library = (await this.global.list()).filter((a) => !ids.has(a.id));
    return { ...roster, agents: [...project, ...library] };
  }

  /** One profile by id: project wins, then the library. */
  async get(id: string): Promise<AgentProfile | null> {
    const roster = await this.store.loadAgents();
    const own = roster.agents.find((a) => a.id === id);
    if (own) return { ...own, scope: "project" };
    return (await this.global.get(id)) ?? null;
  }

  /**
   * Save roster-level fields (defaults) and the project profiles. Library
   * profiles in the payload are dropped, not persisted — a client echoing the
   * merged view back must not copy the library into the project file (and
   * cannot rescope through this method; that is `saveProfile`'s job).
   */
  async saveRoster(input: AgentRoster): Promise<AgentRoster> {
    const roster = AgentRosterSchema.parse(input);
    const project: AgentRoster = {
      ...roster,
      agents: roster.agents
        .filter((a) => a.scope !== "library")
        .map((a) => ({ ...a, scope: "project" as const })),
    };
    await this.store.saveAgents(project);
    this.events.emit("changed", {});
    return this.roster();
  }

  /**
   * Create or update one profile. A blank id mints a fresh one; `scope`
   * decides which store it lands in, defaulting to wherever it already lives
   * (else project). A rescope *moves* the record — the copy in the other
   * scope is deleted in the same save.
   */
  async saveProfile(input: AgentProfile, scope?: AgentProfileScope): Promise<AgentProfile> {
    const profile = AgentProfileSchema.parse({ ...input, id: input.id.trim() || uid("agent") });
    const roster = await this.store.loadAgents();
    const inProject = roster.agents.some((a) => a.id === profile.id);
    const target: AgentProfileScope =
      scope ?? (inProject ? "project" : (await this.global.get(profile.id)) ? "library" : "project");

    if (target === "library") {
      const saved = await this.global.save(profile);
      if (inProject) {
        // Moved out of the project: drop the stale copy. (The global store
        // announced its own change already; this one is for the project half.)
        await this.store.saveAgents({
          ...roster,
          agents: roster.agents.filter((a) => a.id !== profile.id),
        });
        this.events.emit("changed", {});
      }
      return saved;
    }

    const stored: AgentProfile = { ...profile, scope: "project" };
    const agents = inProject
      ? roster.agents.map((a) => (a.id === stored.id ? stored : a))
      : [...roster.agents, stored];
    await this.store.saveAgents({ ...roster, agents });
    // Moved into the project: one id must not resolve in both stores.
    await this.global.remove(stored.id);
    this.events.emit("changed", {});
    return stored;
  }

  /**
   * Delete a profile from whichever scope holds it. The roster's default
   * agent is refused — every dispatch fallback resolves through it.
   */
  async removeProfile(id: string): Promise<void> {
    const roster = await this.store.loadAgents();
    if (roster.defaultAgentId === id) {
      throw new Error(`Agent ${id} is the roster's default — pick another default first.`);
    }
    const fromProject = roster.agents.some((a) => a.id === id);
    if (fromProject) {
      await this.store.saveAgents({
        ...roster,
        agents: roster.agents.filter((a) => a.id !== id),
        managerAgentId: roster.managerAgentId === id ? null : roster.managerAgentId,
      });
      this.events.emit("changed", {});
    }
    // Global removal announces itself through the subscription above.
    const fromGlobal = await this.global.remove(id);
    if (!fromProject && !fromGlobal) throw new Error(`Unknown agent profile: ${id}`);
  }
}
