import fs from "node:fs/promises";
import path from "node:path";
import {
  Emitter,
  WORKFLOW_TEMPLATES,
  WorkflowTemplateSchema,
  templateScope,
  uid,
  validateWorkflowTemplate,
  type TemplateScope,
  type WorkflowTemplate,
} from "@crystal/core";

/**
 * Where workflow templates live, in the two scopes a user can author into.
 *
 * The library is deliberately *not* a {@link JsonRecordStore}: that class
 * exists for records mutated by racing settlement events, and pays for it with
 * a per-record write queue and mandatory `updatedAt` stamping. A template is
 * replaced wholesale by one person clicking Save in a builder — there is no
 * read-modify-write to serialize — so it gets a plain load-once map instead.
 * What it *does* copy from the record store, because those lessons cost the
 * same twice: a corrupt file is skipped rather than fatal, and the change
 * event fires only after the write lands.
 *
 * Two scopes, one lookup:
 *
 *  - **global** (`~/.crystal/workflow-templates`) is shared by every project
 *    on this machine, and is the vocabulary the hub dispatches against — a
 *    program splits into deliveries across repos, so those repos need to be
 *    able to name the same shape of work. One {@link GlobalTemplateStore} per
 *    server, handed to every workspace's library.
 *  - **project** (`<appData>/workflows/templates`) is pinned to one workspace,
 *    for a shape that only makes sense in that repo, and never leaks into
 *    another project's list.
 *
 * Built-ins are read-only and come from core, so they are never on disk.
 */

/** The scopes a user can actually write to (built-ins are read-only). */
export type WritableScope = Exclude<TemplateScope, "builtin">;

/** A directory of template JSON files, loaded once and kept in memory. */
class TemplateDir {
  private templates = new Map<string, WorkflowTemplate>();
  private loading: Promise<void> | null = null;

  constructor(
    readonly dir: string,
    private readonly scope: WritableScope,
  ) {}

  ensureLoaded(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
        // The directory a template was found in is the authority on its
        // scope, not the field inside it: a file copied from the global
        // directory into a project's would otherwise keep claiming to be
        // global and be saved back to the wrong place.
        const template = WorkflowTemplateSchema.parse({ ...raw, scope: this.scope });
        this.templates.set(template.id, template);
      } catch (err) {
        console.warn(
          `[crystal] skipping unreadable workflow template ${name}:`,
          (err as Error).message,
        );
      }
    }
  }

  list(): WorkflowTemplate[] {
    return [...this.templates.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  get(id: string): WorkflowTemplate | undefined {
    return this.templates.get(id);
  }

  async save(template: WorkflowTemplate): Promise<WorkflowTemplate> {
    const stored = { ...template, scope: this.scope };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      path.join(this.dir, `${stored.id}.json`),
      JSON.stringify(stored, null, 2),
      "utf8",
    );
    this.templates.set(stored.id, stored);
    return stored;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.templates.delete(id)) return false;
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

/**
 * The machine-wide template directory. One instance per server: two
 * workspaces open at once share these templates, so a save in either must be
 * visible — and announced — in both. Workspace libraries subscribe to
 * {@link events} for exactly that.
 */
export class GlobalTemplateStore {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private readonly dir: TemplateDir;

  constructor(dir: string) {
    this.dir = new TemplateDir(dir, "global");
  }

  async list(): Promise<WorkflowTemplate[]> {
    await this.dir.ensureLoaded();
    return this.dir.list();
  }

  async get(id: string): Promise<WorkflowTemplate | undefined> {
    await this.dir.ensureLoaded();
    return this.dir.get(id);
  }

  async save(template: WorkflowTemplate): Promise<WorkflowTemplate> {
    await this.dir.ensureLoaded();
    const saved = await this.dir.save(template);
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
 * One workspace's view of the templates it can start a workflow from:
 * built-ins, the shared global library, and this project's own.
 */
export class TemplateLibrary {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private readonly project: TemplateDir;
  private readonly disposeGlobal: () => void;

  constructor(
    projectDir: string,
    private readonly global: GlobalTemplateStore,
  ) {
    this.project = new TemplateDir(projectDir, "project");
    // A global save from another workspace changes this one's list too.
    this.disposeGlobal = this.global.events.on("changed", () =>
      this.events.emit("changed", {}),
    );
  }

  /**
   * Detach from the shared store. Without this, a workspace that closed and
   * reopened would leave its old library forwarding global changes into a
   * dead emitter — the same leak `WorkflowEngine.dispose` exists to prevent.
   */
  dispose(): void {
    this.disposeGlobal();
  }

  /** Built-ins first (stable order), then global, then this project's. */
  async list(): Promise<WorkflowTemplate[]> {
    await this.project.ensureLoaded();
    return [...Object.values(WORKFLOW_TEMPLATES), ...(await this.global.list()), ...this.project.list()];
  }

  /** One template by id across all three scopes, or undefined. */
  async get(id: string): Promise<WorkflowTemplate | undefined> {
    const builtin = WORKFLOW_TEMPLATES[id];
    if (builtin) return builtin;
    await this.project.ensureLoaded();
    return this.project.get(id) ?? (await this.global.get(id));
  }

  /**
   * Create or update a custom template. A blank id mints a fresh one; the
   * scope decides which directory it lands in, defaulting to the template's
   * own. Built-in ids are refused — they are derived from, not edited.
   *
   * Changing the scope of an existing template *moves* it: saving a project
   * template as global has to delete the project copy, or the same id would
   * exist in both directories and `get` would resolve it by directory
   * precedence rather than by what the user chose.
   */
  async save(input: WorkflowTemplate, scope?: WritableScope): Promise<WorkflowTemplate> {
    await this.project.ensureLoaded();
    const template = WorkflowTemplateSchema.parse({
      ...input,
      id: input.id.trim() || uid("wft"),
    });
    if (WORKFLOW_TEMPLATES[template.id]) {
      throw new Error(
        `Template "${template.id}" is built-in and read-only — derive a copy to edit it.`,
      );
    }
    const errors = validateWorkflowTemplate(template);
    if (errors.length) throw new Error(`Invalid template: ${errors.join(" ")}`);

    const target: WritableScope = scope ?? (templateScope(template) === "global" ? "global" : "project");
    const saved =
      target === "global"
        ? await this.global.save(template)
        : await this.project.save(template);
    if (target === "global") {
      // Moved out of the project: drop the stale copy. (The global store
      // announced its own change already; this one is for the project half.)
      if (await this.project.remove(template.id)) this.events.emit("changed", {});
    } else {
      await this.global.remove(template.id);
      this.events.emit("changed", {});
    }
    return saved;
  }

  /** Delete a custom template from whichever scope holds it. */
  async remove(templateId: string): Promise<void> {
    await this.project.ensureLoaded();
    if (WORKFLOW_TEMPLATES[templateId]) {
      throw new Error(`Template "${templateId}" is built-in and cannot be deleted.`);
    }
    const fromProject = await this.project.remove(templateId);
    if (fromProject) this.events.emit("changed", {});
    // Global removal announces itself through the subscription above.
    const fromGlobal = await this.global.remove(templateId);
    if (!fromProject && !fromGlobal) throw new Error(`Unknown template: ${templateId}`);
  }
}
