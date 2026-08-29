import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_FILE,
  ARCHITECTURE_DIR,
  ARCH_DRAFTS_DIR,
  ARCH_OVERLAY_FILE,
  AgentRosterSchema,
  ArchOverlaySchema,
  CRYSTAL_DIR,
  PROJECTS_DIR,
  ROUTE_SAMPLES_FILE,
  RouteSamplesFileSchema,
  SERVICES_FILE,
  STANDING_TASKS_FILE,
  ServicesFileSchema,
  StandingTasksFileSchema,
  SYSTEMS_LAYOUT_FILE,
  TODOS_FILE,
  TodoListSchema,
  WORKSPACE_FILE,
  WorkspaceFacetsFileSchema,
  createArchitectureGraph,
  createDefaultRoster,
  createProject,
  createRepoRef,
  createServicesFile,
  createStandingTasksFile,
  createTodoList,
  createWorkspaceManifest,
  parseCrystalFile,
  serializeCrystalFile,
  slugify,
  type AgentRoster,
  type RouteSamples,
  type ArchDraft,
  type ArchOverlay,
  type ArchitectureGraph,
  type Project,
  type ServicesFile,
  type StandingTasksFile,
  type SystemsLayout,
  type TodoList,
  type WorkspaceFacet,
  type WorkspaceInfo,
  type WorkspaceManifest,
} from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath, workspaceIdFor } from "./paths.js";

/** Saved workspace facets — plain JSON (no crystal envelope), see core's lens.ts. */
const FACETS_FILE = `${CRYSTAL_DIR}/facets.json`;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect git repos at the root and one level deep. */
async function detectRepos(root: string): Promise<{ name: string; path: string }[]> {
  const repos: { name: string; path: string }[] = [];
  if (await exists(path.join(root, ".git"))) {
    repos.push({ name: path.basename(root), path: "." });
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredDir(entry.name)) continue;
    if (await exists(path.join(root, entry.name, ".git"))) {
      repos.push({ name: entry.name, path: entry.name });
    }
  }
  return repos;
}

export class WorkspaceStore {
  constructor(readonly root: string) {}

  /** Load the workspace, creating and seeding `.crystal/` on first run. */
  async load(): Promise<WorkspaceInfo> {
    const manifest = await this.loadOrInitManifest();
    const architectures = (
      await this.loadKindDir<ArchitectureGraph>(ARCHITECTURE_DIR, "architecture")
    ).map((e) => ({ path: e.path, graph: e.data }));
    const archDrafts = (await this.loadKindDir<ArchDraft>(ARCH_DRAFTS_DIR, "archdraft")).map(
      (e) => ({ path: e.path, draft: e.data }),
    );
    const projects = (await this.loadKindDir<Project>(PROJECTS_DIR, "project")).map(
      (e) => ({ path: e.path, project: e.data }),
    );

    if (architectures.length === 0) {
      architectures.push(await this.createArchitecture("Overview"));
    }
    if (projects.length === 0) {
      projects.push(await this.createProject("General"));
    }

    const root = path.resolve(this.root);
    return { id: workspaceIdFor(root), root, manifest, architectures, archDrafts, projects };
  }

  /**
   * Just the boards. `load()` also reads and parses every architecture and
   * every arch draft — drafts are full graph snapshots, so they usually
   * dominate its cost — and callers that only want tasks (question sweeps,
   * board lookups) should not pay for that.
   */
  async loadProjects(): Promise<{ path: string; project: Project }[]> {
    const projects = (await this.loadKindDir<Project>(PROJECTS_DIR, "project")).map((e) => ({
      path: e.path,
      project: e.data,
    }));
    // `load()` seeds a first board on an empty workspace; mirror that so a
    // caller never has to special-case "no boards yet".
    if (projects.length === 0) projects.push(await this.createProject("General"));
    return projects;
  }

  private async loadOrInitManifest(): Promise<WorkspaceManifest> {
    const file = resolveInRoot(this.root, WORKSPACE_FILE);
    if (await exists(file)) {
      const manifest = parseCrystalFile("workspace", await fs.readFile(file, "utf8"));
      return manifest;
    }
    const manifest = createWorkspaceManifest(path.basename(path.resolve(this.root)));
    for (const repo of await detectRepos(this.root)) {
      manifest.repos.push(createRepoRef(repo.name, repo.path));
    }
    await this.saveManifest(manifest);
    return manifest;
  }

  async saveManifest(manifest: WorkspaceManifest): Promise<void> {
    const file = resolveInRoot(this.root, WORKSPACE_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("workspace", manifest), "utf8");
  }

  private async loadKindDir<T>(
    dir: string,
    kind: "architecture" | "archdraft" | "project",
  ): Promise<{ path: string; data: T }[]> {
    const abs = resolveInRoot(this.root, dir);
    if (!(await exists(abs))) return [];
    const out: { path: string; data: T }[] = [];
    for (const name of await fs.readdir(abs)) {
      if (!name.endsWith(".json")) continue;
      // The canonical-architecture overlay lives in the architecture dir but
      // is its own envelope kind, not a diagram.
      if (kind === "architecture" && name === "overlay.json") continue;
      const file = path.join(abs, name);
      try {
        const data = parseCrystalFile(kind, await fs.readFile(file, "utf8")) as T;
        out.push({ path: toRelPath(this.root, file), data });
      } catch (err) {
        console.warn(`[crystal] skipping unreadable ${kind} file ${name}:`, (err as Error).message);
      }
    }
    return out;
  }

  async createArchitecture(name: string): Promise<{ path: string; graph: ArchitectureGraph }> {
    const graph = createArchitectureGraph(name);
    const rel = `${ARCHITECTURE_DIR}/${await this.uniqueSlug(ARCHITECTURE_DIR, name)}.json`;
    await this.saveArchitecture(rel, graph);
    return { path: rel, graph };
  }

  async saveArchitecture(relPath: string, graph: ArchitectureGraph): Promise<void> {
    this.assertInside(relPath, ARCHITECTURE_DIR);
    const abs = resolveInRoot(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeCrystalFile("architecture", graph), "utf8");
  }

  async deleteArchitecture(relPath: string): Promise<void> {
    this.assertInside(relPath, ARCHITECTURE_DIR);
    await fs.rm(resolveInRoot(this.root, relPath), { force: true });
  }

  async createArchDraft(draft: ArchDraft): Promise<{ path: string; draft: ArchDraft }> {
    const rel = `${ARCH_DRAFTS_DIR}/${await this.uniqueSlug(ARCH_DRAFTS_DIR, draft.name)}.json`;
    await this.saveArchDraft(rel, draft);
    return { path: rel, draft };
  }

  async saveArchDraft(relPath: string, draft: ArchDraft): Promise<void> {
    this.assertInside(relPath, ARCH_DRAFTS_DIR);
    const abs = resolveInRoot(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeCrystalFile("archdraft", draft), "utf8");
  }

  async deleteArchDraft(relPath: string): Promise<void> {
    this.assertInside(relPath, ARCH_DRAFTS_DIR);
    await fs.rm(resolveInRoot(this.root, relPath), { force: true });
  }

  async createProject(name: string): Promise<{ path: string; project: Project }> {
    const project = createProject(name);
    const rel = `${PROJECTS_DIR}/${await this.uniqueSlug(PROJECTS_DIR, name)}.json`;
    await this.saveProject(rel, project);
    return { path: rel, project };
  }

  /** Load the todo list (empty when the file doesn't exist yet). */
  async loadTodos(): Promise<TodoList> {
    const file = resolveInRoot(this.root, TODOS_FILE);
    if (!(await exists(file))) return createTodoList();
    return parseCrystalFile("todos", await fs.readFile(file, "utf8"));
  }

  async saveTodos(todos: TodoList): Promise<void> {
    // Validate before writing — a bad payload must not corrupt the file for
    // every later read.
    const parsed = TodoListSchema.parse(todos);
    const file = resolveInRoot(this.root, TODOS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("todos", parsed), "utf8");
  }

  /** Load saved workspace facets (empty when the file is absent or corrupt). */
  async loadFacets(): Promise<WorkspaceFacet[]> {
    const file = resolveInRoot(this.root, FACETS_FILE);
    if (!(await exists(file))) return [];
    try {
      return WorkspaceFacetsFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))).facets;
    } catch {
      // A corrupt file means no saved facets, not a broken workspace.
      return [];
    }
  }

  async saveFacets(facets: WorkspaceFacet[]): Promise<void> {
    // Validate before writing — a bad payload must not corrupt the file for
    // every later read.
    const parsed = WorkspaceFacetsFileSchema.parse({ facets });
    const file = resolveInRoot(this.root, FACETS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  /**
   * Load the architecture overlay — the user-authored half of the one
   * canonical architecture diagram. Null until first saved; the caller
   * (server handler) decides whether an absent overlay means "create empty"
   * or "migrate legacy diagrams".
   */
  async loadArchOverlay(): Promise<ArchOverlay | null> {
    const file = resolveInRoot(this.root, ARCH_OVERLAY_FILE);
    if (!(await exists(file))) return null;
    return parseCrystalFile("arch-overlay", await fs.readFile(file, "utf8"));
  }

  async saveArchOverlay(overlay: ArchOverlay): Promise<void> {
    // Validate before writing — a bad payload must not corrupt the file for
    // every later read.
    const parsed = ArchOverlaySchema.parse(overlay);
    const file = resolveInRoot(this.root, ARCH_OVERLAY_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("arch-overlay", parsed), "utf8");
  }

  /** Route samples for parameterised screens (empty when absent or corrupt). */
  async loadRouteSamples(): Promise<RouteSamples> {
    const file = resolveInRoot(this.root, ROUTE_SAMPLES_FILE);
    if (!(await exists(file))) return {};
    try {
      return RouteSamplesFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))).routes;
    } catch {
      return {};
    }
  }

  /** Replace one route's samples (empty params drop the route). Returns the whole map. */
  async setRouteSamples(route: string, params: Record<string, string>): Promise<RouteSamples> {
    const routes = { ...(await this.loadRouteSamples()) };
    const kept = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ""));
    if (Object.keys(kept).length > 0) routes[route] = kept;
    else delete routes[route];
    const parsed = RouteSamplesFileSchema.parse({ routes });
    const file = resolveInRoot(this.root, ROUTE_SAMPLES_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return parsed.routes;
  }

  /** Managed-service definitions (`.crystal/services.json`; empty file when absent). */
  async loadServices(): Promise<ServicesFile> {
    const file = resolveInRoot(this.root, SERVICES_FILE);
    if (!(await exists(file))) return createServicesFile();
    return parseCrystalFile("services", await fs.readFile(file, "utf8"));
  }

  /**
   * Validate-and-write the services file (the one validation layer for this
   * payload — callers pass raw input). Returns the parsed form, defaults
   * filled, so callers can trust it without re-parsing.
   */
  async saveServices(services: unknown): Promise<ServicesFile> {
    const parsed = ServicesFileSchema.parse(services);
    const file = resolveInRoot(this.root, SERVICES_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("services", parsed), "utf8");
    return parsed;
  }

  /** Standing-task definitions (`.crystal/standing-tasks.json`; empty when absent). */
  async loadStandingTasks(): Promise<StandingTasksFile> {
    const file = resolveInRoot(this.root, STANDING_TASKS_FILE);
    if (!(await exists(file))) return createStandingTasksFile();
    return parseCrystalFile("standing", await fs.readFile(file, "utf8"));
  }

  /** Validate-and-write (single validation layer); returns the parsed form. */
  async saveStandingTasks(tasks: unknown): Promise<StandingTasksFile> {
    const parsed = StandingTasksFileSchema.parse(tasks);
    const file = resolveInRoot(this.root, STANDING_TASKS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("standing", parsed), "utf8");
    return parsed;
  }

  /** Load the systems-overview arrangement (null until the user first edits it). */
  async loadSystemsLayout(): Promise<SystemsLayout | null> {
    const file = resolveInRoot(this.root, SYSTEMS_LAYOUT_FILE);
    if (!(await exists(file))) return null;
    return parseCrystalFile("syslayout", await fs.readFile(file, "utf8"));
  }

  /** Load the agent roster (seeded defaults when the file doesn't exist yet). */
  async loadAgents(): Promise<AgentRoster> {
    const file = resolveInRoot(this.root, AGENTS_FILE);
    if (!(await exists(file))) return createDefaultRoster();
    return parseCrystalFile("agents", await fs.readFile(file, "utf8"));
  }

  async saveAgents(roster: AgentRoster): Promise<void> {
    // Validate before writing — a bad payload must not corrupt the file for
    // every later read.
    const parsed = AgentRosterSchema.parse(roster);
    const file = resolveInRoot(this.root, AGENTS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("agents", parsed), "utf8");
  }

  async saveProject(relPath: string, project: Project): Promise<void> {
    this.assertInside(relPath, PROJECTS_DIR);
    const abs = resolveInRoot(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeCrystalFile("project", project), "utf8");
  }

  private assertInside(relPath: string, dir: string): void {
    const normalized = relPath.replace(/\\/g, "/");
    if (!normalized.startsWith(dir + "/") || normalized.includes("..")) {
      throw new Error(`Path must be inside ${dir}: ${relPath}`);
    }
  }

  private async uniqueSlug(dir: string, name: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    for (let i = 2; ; i++) {
      const abs = resolveInRoot(this.root, `${dir}/${candidate}.json`);
      if (!(await exists(abs))) return candidate;
      candidate = `${base}-${i}`;
    }
  }

  /** Ensure nothing outside the workspace, and nothing in `.crystal-data`. */
  resolve(rel: string): string {
    return resolveInRoot(this.root, rel);
  }

  crystalDirAbs(): string {
    return resolveInRoot(this.root, CRYSTAL_DIR);
  }
}
