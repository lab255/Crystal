import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_FILE,
  ARCHITECTURE_DIR,
  ARCH_DRAFTS_DIR,
  AgentRosterSchema,
  CRYSTAL_DIR,
  PROJECTS_DIR,
  SYSTEMS_LAYOUT_FILE,
  SystemsLayoutSchema,
  TODOS_FILE,
  TodoListSchema,
  WORKSPACE_FILE,
  WorkspaceFacetsFileSchema,
  createArchitectureGraph,
  createDefaultRoster,
  createProject,
  createRepoRef,
  createTodoList,
  createWorkspaceManifest,
  parseCrystalFile,
  serializeCrystalFile,
  slugify,
  type AgentRoster,
  type ArchDraft,
  type ArchitectureGraph,
  type Project,
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

  /** Load the systems-overview arrangement (null until the user first edits it). */
  async loadSystemsLayout(): Promise<SystemsLayout | null> {
    const file = resolveInRoot(this.root, SYSTEMS_LAYOUT_FILE);
    if (!(await exists(file))) return null;
    return parseCrystalFile("syslayout", await fs.readFile(file, "utf8"));
  }

  async saveSystemsLayout(layout: SystemsLayout): Promise<void> {
    // Validate before writing — a bad payload must not corrupt the file for
    // every later read.
    const parsed = SystemsLayoutSchema.parse(layout);
    const file = resolveInRoot(this.root, SYSTEMS_LAYOUT_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCrystalFile("syslayout", parsed), "utf8");
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
