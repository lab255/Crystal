import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BridgeEventName,
  BridgeEvents,
  CrossImportUse,
  CrossPackageUse,
  CrossWorkspaceEdge,
  CrossWorkspaceMap,
  RecentWorkspace,
  WorkspaceDescriptor,
} from "@crystal/core";
import { AgentManager } from "./agent-manager.js";
import { AnalysisBackend, createCodeMapFacade, type CodeMapFacade } from "./analysis-host.js";
import { CodeIndexService } from "./code-index.js";
import { type CrossSurface } from "./code-map.js";
import { OrchestrationService } from "./orchestration.js";
import { appDataDir, isIgnoredDir, workspaceIdFor } from "./paths.js";
import { QualityService } from "./quality-runner.js";
import { RefactorEngine } from "./refactor.js";
import { SettledRuns } from "./settled-runs.js";
import { TerminalManager } from "./terminal-manager.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkspaceStore } from "./workspace-store.js";

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Enrichment files an indexing agent may drop while running. */
const INDEX_FILE_RE = /^\.crystal\/index\//;

/** Where the set of open workspace roots persists across server restarts. */
function openWorkspacesFile(): string {
  return path.join(os.homedir(), ".crystal", "open-workspaces.json");
}

/** How many recently-opened workspaces the reopen list keeps. */
const MAX_RECENTS = 12;

/** realpath expands Windows 8.3 short paths, which crash libuv's recursive fs watcher. */
export function canonicalRoot(p: string): string {
  try {
    return fsSync.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

type Broadcast = <E extends BridgeEventName>(event: E, payload: BridgeEvents[E]) => void;

/** Everything the server holds per open workspace. */
export class WorkspaceRuntime {
  readonly id: string;
  readonly store: WorkspaceStore;
  readonly agents: AgentManager;
  readonly terminals: TerminalManager;
  readonly codemap: CodeMapFacade;
  readonly codeindex: CodeIndexService;
  readonly quality: QualityService;
  readonly orchestration: OrchestrationService;
  readonly workflows: WorkflowEngine;
  /** Manifest name, kept fresh by workspace.get / saveManifest handlers. */
  name: string;

  private watcher: fsSync.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private disposeAgentListeners: (() => void)[] = [];
  private refactorEngine: RefactorEngine | null = null;
  /** Worker thread hosting the CPU-heavy code-map analysis (see analysis-host). */
  private readonly analysis: AnalysisBackend;

  constructor(
    readonly root: string,
    /** Base URL of the server's in-process MCP endpoint (enables manager tools). */
    mcpBaseUrl: string | null = null,
  ) {
    this.id = workspaceIdFor(root);
    this.name = path.basename(root);
    this.store = new WorkspaceStore(root);
    this.agents = new AgentManager(
      root,
      appDataDir(root),
      undefined,
      mcpBaseUrl ? { baseUrl: mcpBaseUrl, scope: this.id } : null,
    );
    this.terminals = new TerminalManager(root);
    this.analysis = new AnalysisBackend(root);
    this.codemap = createCodeMapFacade(this.analysis);
    this.codeindex = new CodeIndexService(root, this.codemap);
    this.quality = new QualityService(root);
    this.orchestration = new OrchestrationService(this.store, this.agents, () =>
      this.notifyWorkspaceChanged?.(),
    );
    // Installs the dispatch guard (pause/budget veto) and settle hooks.
    this.workflows = new WorkflowEngine(appDataDir(root), this.agents, this.store);
    // A worker dispatched against a claimed task inherits the lease, so it is
    // released when the work settles rather than when the manager's turn ends.
    this.agents.onWorkerDispatched = (worker) => {
      void this.orchestration.transferLeaseToRun(worker);
    };
  }

  /** Set by start(): board writes announce themselves like manifest edits do. */
  private notifyWorkspaceChanged: (() => void) | null = null;
  /** Runs already billed to their task (settlement fires once per run). */
  private readonly settledRuns = new SettledRuns();

  /** Attach a run's CRYSTAL_QUESTION to its board task. */
  private async fileQuestion(runId: string, text: string): Promise<void> {
    try {
      const run = await this.agents.get(runId);
      if (!run?.taskId) return;
      const projectPath = await this.orchestration.projectPathForRun(run);
      await this.orchestration.addQuestion(projectPath, run.taskId, text, runId);
    } catch {
      // A question that can't be filed must not take down the event stream.
    }
  }

  descriptor(): WorkspaceDescriptor {
    return { id: this.id, root: this.root, name: this.name };
  }

  /** LanguageService-backed refactor engine, created on first use. */
  refactor(): RefactorEngine {
    return (this.refactorEngine ??= new RefactorEngine(this.root, this.codemap));
  }

  start(broadcast: Broadcast): void {
    this.notifyWorkspaceChanged = () => broadcast("workspace.changed", { ws: this.id });
    this.disposeAgentListeners = [
      this.agents.events.on("event", (payload) => {
        broadcast("agent.event", payload);
        // File CRYSTAL_QUESTION lines on the run's task server-side — a
        // question must land on the board even when no browser is open.
        if (payload.event.type === "question") {
          void this.fileQuestion(payload.runId, payload.event.text);
        }
      }),
      this.agents.events.on("runChanged", ({ run }) => {
        broadcast("agent.runChanged", { ws: this.id, run });
        // Terminal states bill the run's task and heal its lease — once.
        if (this.settledRuns.claim(run)) void this.orchestration.settleRun(run);
      }),
      this.terminals.events.on("data", ({ chunk }) =>
        broadcast("terminal.data", { ws: this.id, chunk }),
      ),
      this.terminals.events.on("changed", ({ terminal }) =>
        broadcast("terminal.changed", { ws: this.id, terminal }),
      ),
      this.quality.events.on("runChanged", ({ run }) =>
        broadcast("quality.runChanged", { ws: this.id, run }),
      ),
      this.quality.events.on("coverageChanged", () =>
        broadcast("quality.coverageChanged", { ws: this.id }),
      ),
      this.workflows.events.on("changed", ({ workflow }) =>
        broadcast("workflow.changed", { ws: this.id, workflow }),
      ),
      this.workflows.events.on("templatesChanged", () =>
        broadcast("workflow.templatesChanged", { ws: this.id }),
      ),
    ];
    try {
      this.watcher = fsSync.watch(this.root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join("/");
        if (rel.split("/").some((part) => isIgnoredDir(part))) return;
        this.pendingPaths.add(rel);
        this.watchTimer ??= setTimeout(() => {
          this.watchTimer = null;
          const paths = [...this.pendingPaths];
          this.pendingPaths.clear();
          // A throw here (a broadcast listener, an invalidation) would ride
          // the timer straight to uncaughtException — contain it.
          try {
            broadcast("fs.changed", { ws: this.id, paths });
            const codeChanged = paths.some((p) => CODE_FILE_RE.test(p) && !INDEX_FILE_RE.test(p));
            if (codeChanged) {
              void this.codemap.invalidate();
              broadcast("codemap.changed", { ws: this.id });
            }
            // The index follows both the code and agent-written enrichments.
            if (codeChanged || paths.some((p) => INDEX_FILE_RE.test(p))) {
              this.codeindex.invalidate();
              broadcast("codeindex.changed", { ws: this.id });
            }
          } catch (err) {
            console.warn(`[crystal] watcher flush failed for ${this.root}:`, (err as Error).message);
          }
        }, 250);
      });
      // An unhandled 'error' on the watcher would crash the process.
      this.watcher.on("error", (err) => {
        console.warn(`[crystal] fs watch error for ${this.root}:`, (err as Error).message);
      });
    } catch (err) {
      console.warn(`[crystal] fs watch unavailable for ${this.root}:`, (err as Error).message);
    }
  }

  close(): void {
    this.watcher?.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    for (const dispose of this.disposeAgentListeners) dispose();
    this.disposeAgentListeners = [];
    // A replaced engine must not keep settling runs into the same app-data
    // files after the workspace reopens with a fresh one.
    this.workflows.dispose();
    this.terminals.disposeAll();
    this.quality.dispose();
    this.refactorEngine?.dispose();
    this.refactorEngine = null;
    this.analysis.dispose();
  }
}

/**
 * The set of workspaces a bridge server is hosting. Every workspace-scoped
 * bridge method resolves through `get(ws)`; the open set persists to
 * `~/.crystal/open-workspaces.json` so a restarted server reopens them.
 */
export class WorkspaceRegistry {
  private runtimes = new Map<string, WorkspaceRuntime>();
  private defaultId: string | null = null;
  /** Reopen list, most recent last (map insertion order); loaded lazily from the persist file. */
  private recentsByRoot = new Map<string, RecentWorkspace>();
  private recentsLoad: Promise<void> | null = null;

  constructor(
    private readonly broadcast: Broadcast,
    /** Where to persist the open set; null disables persistence entirely. */
    private readonly persistFile: string | null = openWorkspacesFile(),
    /** Base URL of the in-process MCP endpoint, forwarded to each runtime. */
    private readonly mcpBaseUrl: string | null = null,
  ) {}

  /** Open (or return the already-open) workspace at `root`. */
  async open(root: string): Promise<WorkspaceRuntime> {
    const canonical = canonicalRoot(root);
    const stat = await fs.stat(canonical).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${root}`);
    const id = workspaceIdFor(canonical);
    const existing = this.runtimes.get(id);
    if (existing) return existing;

    const runtime = new WorkspaceRuntime(canonical, this.mcpBaseUrl);
    // Warm the workspace (creates .crystal/ on first run) and pick up its name.
    const info = await runtime.store.load();
    runtime.name = info.manifest.name;
    this.runtimes.set(id, runtime);
    this.defaultId ??= id;
    runtime.start(this.broadcast);
    await this.noteRecent(runtime);
    await this.persist();
    this.broadcast("workspaces.changed", {});
    return runtime;
  }

  /** Move `runtime` to the top of the reopen list (most recent last in the map). */
  private async noteRecent(runtime: WorkspaceRuntime): Promise<void> {
    await this.ensureRecentsLoaded();
    this.recentsByRoot.delete(runtime.root);
    this.recentsByRoot.set(runtime.root, {
      root: runtime.root,
      name: runtime.name,
      lastOpenedAt: new Date().toISOString(),
    });
    while (this.recentsByRoot.size > MAX_RECENTS) {
      const oldest = this.recentsByRoot.keys().next().value;
      if (oldest === undefined) break;
      this.recentsByRoot.delete(oldest);
    }
  }

  /**
   * The reopen list, most recent first. Open workspaces carry their live name
   * (a rename mid-session beats the name captured at open time); gone
   * directories are flagged `missing` rather than dropped, so a temporarily
   * unmounted drive doesn't erase history.
   */
  async recents(): Promise<RecentWorkspace[]> {
    await this.ensureRecentsLoaded();
    const liveNames = new Map([...this.runtimes.values()].map((r) => [r.root, r.name]));
    return Promise.all(
      [...this.recentsByRoot.values()].reverse().map(async (r) => {
        const stat = await fs.stat(r.root).catch(() => null);
        return {
          ...r,
          name: liveNames.get(r.root) ?? r.name,
          ...(stat?.isDirectory() ? {} : { missing: true }),
        };
      }),
    );
  }

  /** Close a workspace (the last one cannot be closed). */
  async close(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown workspace: ${id}`);
    if (this.runtimes.size === 1) throw new Error("Cannot close the last workspace");
    runtime.close();
    this.runtimes.delete(id);
    if (this.defaultId === id) this.defaultId = this.runtimes.keys().next().value ?? null;
    await this.persist();
    this.broadcast("workspaces.changed", {});
  }

  get(ws?: string): WorkspaceRuntime {
    const id = ws ?? this.defaultId;
    const runtime = id ? this.runtimes.get(id) : undefined;
    if (!runtime) throw new Error(`Unknown workspace: ${ws ?? "(default)"}`);
    return runtime;
  }

  list(): WorkspaceDescriptor[] {
    return [...this.runtimes.values()].map((r) => r.descriptor());
  }

  get defaultWs(): string {
    if (!this.defaultId) throw new Error("No workspaces open");
    return this.defaultId;
  }

  closeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
    this.defaultId = null;
  }

  /** Reopen workspaces persisted by a previous run (silently skips gone dirs). */
  async restorePersisted(): Promise<void> {
    if (!this.persistFile) return;
    let roots: string[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(this.persistFile, "utf8"));
      if (Array.isArray(parsed?.roots)) roots = parsed.roots.filter((r: unknown) => typeof r === "string");
    } catch {
      return;
    }
    for (const root of roots) {
      try {
        await this.open(root);
      } catch (err) {
        console.warn(`[crystal] skipping persisted workspace ${root}:`, (err as Error).message);
      }
    }
  }

  /** One-shot read of the persisted reopen list (pre-recents files just yield an empty list). */
  private ensureRecentsLoaded(): Promise<void> {
    return (this.recentsLoad ??= (async () => {
      if (!this.persistFile) return;
      try {
        const parsed = JSON.parse(await fs.readFile(this.persistFile, "utf8"));
        if (!Array.isArray(parsed?.recents)) return;
        for (const r of parsed.recents) {
          if (typeof r?.root === "string" && typeof r?.name === "string" && typeof r?.lastOpenedAt === "string") {
            this.recentsByRoot.set(r.root, { root: r.root, name: r.name, lastOpenedAt: r.lastOpenedAt });
          }
        }
      } catch {
        /* first run or unreadable — start with an empty reopen list */
      }
    })());
  }

  private async persist(): Promise<void> {
    const file = this.persistFile;
    if (!file) return;
    // Loading first means a close() before any open() can't clobber stored recents.
    await this.ensureRecentsLoaded();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify(
          {
            roots: [...this.runtimes.values()].map((r) => r.root),
            recents: [...this.recentsByRoot.values()],
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      console.warn("[crystal] could not persist open workspaces:", (err as Error).message);
    }
  }

  /** Cross-workspace import/export graph across every open workspace. */
  async crossMap(): Promise<CrossWorkspaceMap> {
    const runtimes = [...this.runtimes.values()];
    const surfaces = new Map<string, CrossSurface>();
    await Promise.all(
      runtimes.map(async (r) => {
        surfaces.set(r.id, await r.codemap.crossSurface());
      }),
    );
    return {
      workspaces: runtimes.map((r) => ({
        ...r.descriptor(),
        fileTotal: surfaces.get(r.id)!.fileTotal,
        packages: [...surfaces.get(r.id)!.packages.keys()].sort(),
      })),
      edges: computeCrossEdges(surfaces),
      generatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Match each workspace's external imports against packages published by the
 * *other* workspaces. Pure so it can be unit-tested without a filesystem.
 */
export function computeCrossEdges(surfaces: Map<string, CrossSurface>): CrossWorkspaceEdge[] {
  const edges: CrossWorkspaceEdge[] = [];
  for (const [sourceWs, surface] of surfaces) {
    // pair key: targetWs → pkg → fromModule → use
    const perTarget = new Map<string, Map<string, { toModule: string; uses: Map<string, CrossImportUse> }>>();
    for (const imp of surface.externalImports) {
      for (const [targetWs, target] of surfaces) {
        if (targetWs === sourceWs) continue;
        const toModule = target.packages.get(imp.pkg);
        if (toModule === undefined) continue;
        let pkgs = perTarget.get(targetWs);
        if (!pkgs) perTarget.set(targetWs, (pkgs = new Map()));
        let entry = pkgs.get(imp.pkg);
        if (!entry) pkgs.set(imp.pkg, (entry = { toModule, uses: new Map() }));
        let use = entry.uses.get(imp.fromModule);
        if (!use) entry.uses.set(imp.fromModule, (use = { fromModule: imp.fromModule, count: 0, names: [] }));
        use.count += 1;
        for (const name of imp.names) if (!use.names.includes(name)) use.names.push(name);
      }
    }
    for (const [targetWs, pkgs] of perTarget) {
      const packages: CrossPackageUse[] = [...pkgs.entries()]
        .map(([pkg, entry]) => {
          const uses = [...entry.uses.values()].sort((a, b) => b.count - a.count);
          return {
            pkg,
            toModule: entry.toModule,
            count: uses.reduce((sum, u) => sum + u.count, 0),
            uses,
          };
        })
        .sort((a, b) => b.count - a.count);
      edges.push({
        source: sourceWs,
        target: targetWs,
        weight: packages.reduce((sum, p) => sum + p.count, 0),
        packages,
      });
    }
  }
  return edges;
}
