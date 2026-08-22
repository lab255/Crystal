import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWatchFirePrompt,
  type BridgeEventName,
  type BridgeEvents,
  type CrossImportUse,
  type CrossPackageUse,
  type CrossWorkspaceEdge,
  type CrossWorkspaceMap,
  type RecentWorkspace,
  type WorkspaceDescriptor,
} from "@crystal/core";
import {
  presetById,
  profileOverlay,
  workflowIdOfRun,
  type AgentProfileOverlay,
  type ModelPreset,
  type ProfileResolutionInput,
} from "@crystal/core";
import { AgentLibrary, GlobalAgentStore } from "./agent-library.js";
import { ALLOWED_RUN_TOOLS, AgentManager } from "./agent-manager.js";
import { PermissionBroker } from "./permission-broker.js";
import { AnalysisBackend, createCodeMapFacade, type CodeMapFacade } from "./analysis-host.js";
import { launchInteractiveRun } from "./interactive.js";
import { CodeIndexService } from "./code-index.js";
import { type CrossSurface } from "./code-map.js";
import { OrchestrationService } from "./orchestration.js";
import {
  appDataDir,
  globalAgentsDir,
  globalTemplatesDir,
  isIgnoredDir,
  workspaceIdFor,
} from "./paths.js";
import { QualityService } from "./quality-runner.js";
import { DevServerService } from "./dev-servers.js";
import { ApiClientStore } from "./api-client-store.js";
import { RefactorEngine } from "./refactor.js";
import { SettledRuns } from "./settled-runs.js";
import { GlobalTemplateStore } from "./template-library.js";
import { GrantsStore } from "./grants-store.js";
import { ServiceManager } from "./service-manager.js";
import { StandingTaskEngine } from "./standing-tasks.js";
import { TerminalManager, pasteInput, type TerminalSeed } from "./terminal-manager.js";
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

/** How many closed workspaces keep their dead terminal tabs for reopen (LRU). */
const MAX_TERMINAL_STASHES = 8;

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
  readonly devservers: DevServerService;
  readonly apiclient: ApiClientStore;
  readonly orchestration: OrchestrationService;
  readonly workflows: WorkflowEngine;
  /** Project roster + shared library, merged (see agent-library.ts). */
  readonly agentLibrary: AgentLibrary;
  /** Per-workspace tool grants + permission-denial tally (see grants-store.ts). */
  readonly grants: GrantsStore;
  /** Pending permission prompts from headless runs (see permission-broker.ts). */
  readonly permissions: PermissionBroker;
  readonly services: ServiceManager;
  readonly standing: StandingTaskEngine;
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
    /**
     * The machine-wide template library. The registry passes its shared
     * instance so a template saved in one workspace is visible in every
     * other; the default is a private store, for a runtime built outside a
     * registry (tests), where there is nothing to share with.
     */
    globalTemplates: GlobalTemplateStore = new GlobalTemplateStore(globalTemplatesDir()),
    /** Same sharing story as templates: one agent library per server. */
    globalAgents: GlobalAgentStore = new GlobalAgentStore(globalAgentsDir()),
  ) {
    this.id = workspaceIdFor(root);
    this.name = path.basename(root);
    this.store = new WorkspaceStore(root);
    this.agentLibrary = new AgentLibrary(this.store, globalAgents);
    this.agents = new AgentManager(
      root,
      appDataDir(root),
      undefined,
      mcpBaseUrl ? { baseUrl: mcpBaseUrl, scope: this.id } : null,
    );
    // The single resolution path: dispatch-by-agentId (workers, resumed
    // chain turns) resolves through the merged project+library view.
    this.agents.profileResolver = (agentId, input) => this.resolveProfile(agentId, input);
    this.agents.presetResolver = () => this.resolvePreset();
    // Workspace consent for dangerously-skip-permissions runs (roster flag) —
    // read per spawn, so flipping the toggle applies to the next run.
    this.agents.bypassResolver = async () =>
      (await this.agentLibrary.roster()).allowBypassPermissions;
    // The workspace's default --permission-mode for runs that don't set one
    // (roster dial; bypass still gated by the consent flag above).
    this.agents.defaultModeResolver = async () =>
      (await this.agentLibrary.roster()).defaultPermissionMode ?? null;
    // Approvals as first-class workspace data: granted tools ride every
    // spawn, and permission denials land in the ledger with their workflow
    // attribution — "delivery X requested tool Y, denied N times".
    this.grants = new GrantsStore(appDataDir(root));
    this.agents.grantsResolver = () => this.grants.allowedTools();
    this.agents.onToolDenied = (run, tool) => {
      void this.grants
        .noteDenial({ tool, runId: run.id, workflowId: workflowIdOfRun(run) })
        .catch((err) => {
          console.warn(`[crystal] could not record tool denial:`, (err as Error).message);
        });
    };
    this.terminals = new TerminalManager(root);
    this.analysis = new AnalysisBackend(root, this.id);
    this.codemap = createCodeMapFacade(this.analysis);
    this.codeindex = new CodeIndexService(root, this.codemap);
    this.quality = new QualityService(root);
    this.devservers = new DevServerService(root, this.terminals);
    this.apiclient = new ApiClientStore(appDataDir(root));
    this.orchestration = new OrchestrationService(this.store, this.agents, () => {
      this.notifyWorkspaceChanged?.();
      // A board write may be the answer to a pending permission question.
      void this.permissions?.onBoardChanged();
    });
    // The permission-prompt broker: headless runs route CLI permission
    // prompts here (--permission-prompt-tool → mcp/http.ts → this). Grants
    // and profile allowlists auto-allow; everything else parks as a board
    // question + run stream event until granted, answered, or timed out.
    this.permissions = new PermissionBroker(
      {
        run: (runId) => this.agents.get(runId),
        grantPatterns: () => this.grants.allowedTools(),
        allowAll: () => this.grants.allowAllEnabled(),
        profilePatterns: async (agentId) =>
          agentId ? ((await this.resolveProfile(agentId))?.allowedTools ?? []) : [],
        note: (runId, event) => this.agents.notePermission(runId, event),
        fileQuestion: async (run, text, options, recommended) => {
          if (!run.taskId) return null;
          const projectPath = await this.orchestration.projectPathForRun(run);
          const result = await this.orchestration.addQuestion(
            projectPath,
            run.taskId,
            text,
            // The full run rides along so the question's origin.workflowId is
            // stamped from its workflow: tag at creation.
            run,
            { options, recommended },
          );
          return result.ok
            ? { projectPath, taskId: run.taskId, questionId: result.questionId }
            : null;
        },
        readClosure: (ref) =>
          this.orchestration.questionClosureOf(ref.projectPath, ref.taskId, ref.questionId),
        closeQuestion: async (ref, runId, note) => {
          await this.orchestration.resolveQuestion(
            ref.projectPath,
            ref.taskId,
            runId,
            note,
            ref.questionId,
          );
        },
        // Same fold the stream-detected denials use — the AgentsTab grants
        // panel shows both under one tally.
        onDenied: (run, tool) => this.agents.onToolDenied?.(run, tool),
      },
      [...ALLOWED_RUN_TOOLS, "mcp__crystal"],
    );
    // A grants edit is the unblock path for parked requests; a settling run
    // can never take an answer, so its requests deny immediately.
    this.grants.events.on("changed", () => void this.permissions.recheckGrants());
    this.agents.events.on("runChanged", ({ run }) => {
      if (SettledRuns.isTerminal(run)) this.permissions.cancelForRun(run.id);
    });
    // Installs the dispatch guard (pause/budget veto) and settle hooks.
    this.workflows = new WorkflowEngine(
      appDataDir(root),
      this.agents,
      this.store,
      globalTemplates,
      this.agentLibrary,
    );
    // A settling workflow expires the open board questions it originated —
    // and answering re-checks the origin workflow so an answer racing the
    // terminal write records instead of paying for a context-less delivery.
    this.workflows.questionExpiry = (workflowId, status) =>
      this.orchestration.expireWorkflowQuestions(workflowId, status);
    this.orchestration.workflowStatusLookup = async (workflowId) =>
      (await this.workflows.get(workflowId))?.status ?? null;
    // Workflow managers can be hosted as native interactive Claude sessions
    // on this workspace's PTYs.
    this.workflows.interactiveLauncher = (params) =>
      launchInteractiveRun(this.agents, this.terminals, params);
    this.services = new ServiceManager(root, appDataDir(root), this.store);
    this.standing = new StandingTaskEngine(appDataDir(root), this.agents, this.store);
    // A fired watch wakes an agent — with one live fix-run per watch, so a
    // crash-looping service can't fan out an army.
    this.services.onWatchFire = async ({ watch, service, reason, logTail }) => {
      if (await this.agents.hasLiveRunTagged(`watch:${watch.id}`)) return;
      await this.agents.start({
        prompt: buildWatchFirePrompt({
          serviceName: service.name,
          command: service.command,
          reason,
          instructions: watch.instructions,
          logTail,
        }),
        cwd: service.cwd,
        purpose: "fix",
        tags: [`watch:${watch.id}`, `service:${service.id}`],
      });
    };
    // A worker dispatched against a claimed task inherits the lease, so it is
    // released when the work settles rather than when the manager's turn ends.
    this.agents.onWorkerDispatched = (worker) => {
      void this.orchestration.transferLeaseToRun(worker);
    };
    // Interactive runs live on this workspace's PTYs: messages for them are
    // typed into the terminal, and cancel kills it.
    this.agents.interactiveInput = (run, text) => {
      if (!run.terminalId) return false;
      try {
        this.terminals.input(run.terminalId, pasteInput(text));
        return true;
      } catch {
        return false; // terminal gone — caller falls back to queue/resume
      }
    };
    this.agents.interactiveKill = (run) => {
      if (!run.terminalId) return;
      // The kill confirms asynchronously; the seam is fire-and-forget by
      // design (cancel returns immediately, the exit lands via broadcast).
      void this.terminals.kill(run.terminalId).catch(() => {
        // already gone
      });
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
      if (!run) return;
      const projectPath = await this.orchestration.projectPathForRun(run);
      const workflow = await this.workflows.workflowForRun(run).catch(() => null);
      await this.orchestration.addQuestionForRun(projectPath, run, text, undefined, {
        epicId: workflow?.epicId ?? null,
      });
    } catch {
      // A question that can't be filed must not take down the event stream.
    }
  }

  descriptor(): WorkspaceDescriptor {
    return { id: this.id, root: this.root, name: this.name };
  }

  /**
   * Resolve an agent profile id to the overlay a dispatch applies — model,
   * skills, standing prompt, tool policy, the `agent:<id>` tag. The one
   * resolution path every handler and engine goes through (design A3).
   */
  async resolveProfile(
    agentId?: string | null,
    input?: ProfileResolutionInput | null,
  ): Promise<AgentProfileOverlay | null> {
    if (!agentId) return null;
    const profile = await this.agentLibrary.get(agentId);
    if (!profile) return null;
    // The roster's preset resolves "auto" model/provider pairs — here, at the
    // one resolution path, so every dispatch sees a CLI-compatible pair.
    const roster = await this.agentLibrary.roster();
    return profileOverlay(profile, presetById(roster.preset), input);
  }

  /** The workspace's model preset (roster `preset` field, default Delegated). */
  async resolvePreset(): Promise<ModelPreset> {
    const roster = await this.agentLibrary.roster();
    return presetById(roster.preset);
  }

  /** LanguageService-backed refactor engine, created on first use. */
  refactor(): RefactorEngine {
    return (this.refactorEngine ??= new RefactorEngine(this.root, this.codemap));
  }

  start(broadcast: Broadcast): void {
    this.notifyWorkspaceChanged = () => broadcast("workspace.changed", { ws: this.id });
    this.disposeAgentListeners = [
      this.codemap.onProgress((progress) => {
        // A stale overview may have rebuilt the semantic index from the old
        // snapshot. Drop it before announcing the completed fresh pass.
        if (progress.phase === "done") this.codeindex.invalidate();
        broadcast("codemap.progress", progress);
        if (progress.phase === "done") broadcast("codemap.changed", { ws: this.id });
      }),
      this.agents.events.on("event", (payload) => {
        broadcast("agent.event", payload);
        // File CRYSTAL_QUESTION lines on the run's task server-side — a
        // question must land on the board even when no browser is open.
        if (payload.event.type === "question") {
          void this.fileQuestion(payload.runId, payload.event.text);
        }
      }),
      this.agents.events.on("authChanged", ({ broken, detail }) =>
        broadcast("agent.authChanged", { ws: this.id, broken, detail }),
      ),
      this.agents.events.on("runChanged", ({ run }) => {
        broadcast("agent.runChanged", { ws: this.id, run });
        // Terminal states bill the run's task and heal its lease — once.
        if (this.settledRuns.claim(run)) void this.orchestration.settleRun(run);
      }),
      this.terminals.events.on("data", ({ chunk }) =>
        broadcast("terminal.data", { ws: this.id, chunk }),
      ),
      this.terminals.events.on("changed", ({ terminal }) => {
        broadcast("terminal.changed", { ws: this.id, terminal });
        // A dying terminal settles any interactive run it hosted — that is
        // what flushes the chain's queued answers into a headless resume.
        if (terminal.status === "exited") {
          void this.agents.settleInteractive(terminal.id, terminal.exitCode);
        }
      }),
      this.quality.events.on("runChanged", ({ run }) =>
        broadcast("quality.runChanged", { ws: this.id, run }),
      ),
      this.devservers.events.on("changed", () =>
        broadcast("devservers.changed", { ws: this.id }),
      ),
      this.apiclient.events.on("changed", () =>
        broadcast("apiclient.changed", { ws: this.id }),
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
      this.grants.events.on("changed", ({ ledger }) =>
        broadcast("grants.changed", { ws: this.id, ledger }),
      ),
      // Every roster mutation — project save here, or a library save from
      // *any* workspace — re-announces this workspace's merged roster.
      this.agentLibrary.events.on("changed", () => {
        void this.agentLibrary
          .roster()
          .then((roster) => broadcast("agents.changed", { ws: this.id, roster }))
          .catch((err) => {
            console.warn(`[crystal] agents.changed broadcast failed:`, (err as Error).message);
          });
      }),
      this.services.events.on("changed", ({ service }) =>
        broadcast("service.changed", { ws: this.id, service }),
      ),
      this.services.events.on("log", ({ chunk }) =>
        broadcast("service.log", { ws: this.id, chunk }),
      ),
      this.services.events.on("watchFired", ({ watch }) =>
        broadcast("service.watchFired", { ws: this.id, watch }),
      ),
      this.standing.events.on("changed", () =>
        broadcast("standing.changed", { ws: this.id }),
      ),
    ];
    this.standing.start();
    // Question-expiry reconcile: terminal transitions that happened (or whose
    // closure write failed) while the server was down still close their
    // stranded board questions. Idempotent; absence of a record closes nothing.
    void this.workflows.reconcileQuestionExpiry().catch((err) => {
      console.warn(
        `[crystal] question-expiry reconcile failed for ${this.root}:`,
        (err as Error).message,
      );
    });
    // Reap crashed-server orphans and restart what the user left running.
    void this.services.restoreDesired().catch((err) => {
      console.warn(`[crystal] service restore failed for ${this.root}:`, (err as Error).message);
    });
    try {
      this.watcher = fsSync.watch(this.root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join("/");
        if (rel.split("/").some((part) => isIgnoredDir(part))) return;
        const queue = (): void => {
          this.pendingPaths.add(rel);
          this.watchTimer ??= setTimeout(async () => {
            this.watchTimer = null;
            const paths = [...this.pendingPaths];
            this.pendingPaths.clear();
            // A throw here (a broadcast listener, an invalidation) would ride
            // the timer straight to uncaughtException — contain it.
            try {
              broadcast("fs.changed", { ws: this.id, paths });
              const codePaths = paths.filter((p) => CODE_FILE_RE.test(p) && !INDEX_FILE_RE.test(p));
              const excluded = await Promise.all(
                codePaths.map((p) => this.codemap.isExcludedPath(p).catch(() => false)),
              );
              const codeChanged = excluded.some((value) => !value);
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
              console.warn(
                `[crystal] watcher flush failed for ${this.root}:`,
                (err as Error).message,
              );
            }
          }, 250);
        };
        queue();
      });
      // An unhandled 'error' on the watcher would crash the process.
      this.watcher.on("error", (err) => {
        console.warn(`[crystal] fs watch error for ${this.root}:`, (err as Error).message);
      });
    } catch (err) {
      console.warn(`[crystal] fs watch unavailable for ${this.root}:`, (err as Error).message);
    }
  }

  /**
   * Tear the runtime down. Resolves once every terminal tree is confirmed
   * dead (a closed workspace is inert — no orphaned shells or bound ports),
   * returning the dead terminal records so the registry can stash them for a
   * buffer-preserving reopen.
   */
  async close(): Promise<TerminalSeed[]> {
    this.watcher?.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    for (const dispose of this.disposeAgentListeners) dispose();
    this.disposeAgentListeners = [];
    // A replaced engine must not keep settling runs into the same app-data
    // files after the workspace reopens with a fresh one.
    this.workflows.dispose();
    // Same story for the shared agent store's subscription.
    this.agentLibrary.dispose();
    this.standing.dispose();
    this.services.dispose();
    // Settle parked permission prompts before killing runs — every waiting
    // MCP HTTP request gets its deny instead of hanging on a dead workspace.
    this.permissions.dispose();
    // Kill live agent runs BEFORE their terminals: a closed workspace with
    // its orchestrator still running is how the hub's one-per-project
    // invariant broke (cancel recorded, orchestrator alive, retry doubled).
    this.agents.disposeAll();
    // Dev servers before the terminal sweep (they release their ledger);
    // their terminals are killed here or by disposeAll below — double-kill
    // is harmless.
    await this.devservers.dispose();
    const seeds = await this.terminals.disposeAll();
    this.quality.dispose();
    this.refactorEngine?.dispose();
    this.refactorEngine = null;
    this.analysis.dispose();
    return seeds;
  }
}

/**
 * The set of workspaces a bridge server is hosting. Every workspace-scoped
 * bridge method resolves through `get(ws)`; the open set persists under
 * `~/.crystal/open-workspaces*.json` (per server flavor when a `persistKey`
 * is given — see the constructor) so a restarted server reopens them.
 */
export class WorkspaceRegistry {
  private runtimes = new Map<string, WorkspaceRuntime>();
  private defaultId: string | null = null;
  /** Reopen list, most recent last (map insertion order); loaded lazily from the persist file. */
  private recentsByRoot = new Map<string, RecentWorkspace>();
  private recentsLoad: Promise<void> | null = null;

  /**
   * Buffer-preserving reopen: when a workspace closes, its (by then dead)
   * terminal records are stashed here — keyed by workspace id, most recent
   * last — so reopening the same root in this server session brings the tabs
   * back as exited shells with scrollback intact. In-memory only and
   * bounded; a server restart starts clean.
   */
  private readonly terminalStash = new Map<string, TerminalSeed[]>();

  /**
   * One template library for the whole server, shared by every workspace it
   * opens. Held here rather than per runtime because that is exactly what
   * "global" means: saving a template in one project must show up in the
   * next, without a reload.
   */
  private readonly globalTemplates = new GlobalTemplateStore(globalTemplatesDir());

  /**
   * The machine-wide agent-profile library, shared the same way. Public
   * because the hub (which lives beside the registry, not inside a
   * workspace) resolves its manager agent ids against it directly.
   */
  readonly globalAgents = new GlobalAgentStore(globalAgentsDir());

  constructor(
    private readonly broadcast: Broadcast,
    /** The shared persist file (recents + legacy open set); null disables persistence. */
    private readonly persistFile: string | null = openWorkspacesFile(),
    /** Base URL of the in-process MCP endpoint, forwarded to each runtime. */
    private readonly mcpBaseUrl: string | null = null,
    /**
     * Server-flavor key for the persisted open set. Two concurrent servers
     * (a pipe-only desktop sidecar and a `--listen` dev server, say) used to
     * clobber each other's `roots` in the one shared file; with a key, each
     * flavor keeps its open set in `open-workspaces.<key>.json` beside the
     * shared file, while `recents` stay merged in the shared file (the reopen
     * list is genuinely machine-global). null keeps the legacy single-file
     * layout (tests, embedders).
     */
    private readonly persistKey: string | null = null,
  ) {}

  /** Per-flavor open-set file, `<shared-basename>.<key>.json` beside the shared file. */
  private flavorFile(): string | null {
    if (!this.persistFile || !this.persistKey) return null;
    const safe = this.persistKey.replace(/[^a-zA-Z0-9_-]/g, "-");
    const base = path.basename(this.persistFile).replace(/\.json$/, "");
    return path.join(path.dirname(this.persistFile), `${base}.${safe}.json`);
  }

  /**
   * Crash sentinel around restore: written (with the roots being reopened)
   * just before the restore loop starts and removed when it completes, so a
   * marker found at boot means the previous restore never finished — the
   * server most likely died opening one of these roots (native watcher or
   * analyzer crash, OOM on a huge repo). Per flavor, like the open set.
   */
  private restoreMarkerFile(): string | null {
    const base = this.flavorFile() ?? this.persistFile;
    return base ? `${base}.restoring` : null;
  }

  /** Roots held back by safe mode (the previous restore crashed); null when none. */
  private safeModeRoots: string[] | null = null;

  /**
   * One-shot snapshot of the previous session's persisted open set, taken
   * before this server's first write. Boot opens the CLI root (which
   * persists) *before* `restorePersisted()` runs — reading the file at
   * restore time would see that write, not the set the last session left
   * behind, and every other workspace would be silently dropped.
   */
  private storedRootsLoad: Promise<string[]> | null = null;

  private loadStoredRoots(): Promise<string[]> {
    return (this.storedRootsLoad ??= (async () => {
      if (!this.persistFile) return [];
      const readRoots = async (file: string): Promise<string[] | null> => {
        try {
          const parsed = JSON.parse(await fs.readFile(file, "utf8"));
          if (!Array.isArray(parsed?.roots)) return null;
          return parsed.roots.filter((r: unknown) => typeof r === "string");
        } catch {
          return null;
        }
      };
      // The per-flavor file wins; the shared legacy file only seeds the first
      // boot after migration (once this flavor persists, its own file exists —
      // and an empty list there is a statement, not an absence).
      const flavor = this.flavorFile();
      return (flavor ? await readRoots(flavor) : null) ?? (await readRoots(this.persistFile)) ?? [];
    })());
  }

  /** Open (or return the already-open) workspace at `root`. */
  async open(root: string): Promise<WorkspaceRuntime> {
    const canonical = canonicalRoot(root);
    const stat = await fs.stat(canonical).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${root}`);
    const id = workspaceIdFor(canonical);
    const existing = this.runtimes.get(id);
    if (existing) return existing;

    const runtime = new WorkspaceRuntime(
      canonical,
      this.mcpBaseUrl,
      this.globalTemplates,
      this.globalAgents,
    );
    // A root closed earlier this session reopens with its terminal tabs
    // restored as exited shells (scrollback intact, no processes) — seeded
    // before start(), so clients pick them up via their terminal.list refresh.
    const stashed = this.terminalStash.get(id);
    if (stashed) {
      this.terminalStash.delete(id);
      runtime.terminals.seed(stashed);
    }
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
    // Out of the map BEFORE the awaited teardown — a bridge call landing
    // mid-close must not resolve a half-closed runtime.
    this.runtimes.delete(id);
    if (this.defaultId === id) this.defaultId = this.runtimes.keys().next().value ?? null;
    const seeds = await runtime.close();
    // Stash the dead tabs for a same-session reopen; re-inserting moves the
    // root to the LRU tail.
    this.terminalStash.delete(id);
    if (seeds.length > 0) {
      this.terminalStash.set(id, seeds);
      while (this.terminalStash.size > MAX_TERMINAL_STASHES) {
        const oldest = this.terminalStash.keys().next().value;
        if (oldest === undefined) break;
        this.terminalStash.delete(oldest);
      }
    }
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

  /**
   * The workspace a `ws`-less call resolves to, or null when none is open —
   * a legitimate state (a first launch with no persisted set), not an error.
   */
  get defaultWs(): string | null {
    return this.defaultId;
  }

  /** Server shutdown: close every runtime, awaiting the terminal kills. */
  async closeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.defaultId = null;
    // allSettled: one runtime failing to tear down must not strand the rest.
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  }

  /**
   * Reopen workspaces persisted by a previous run (silently skips gone dirs).
   * Safe mode: when the previous boot's restore marker is still on disk (that
   * restore never completed — it most likely crashed the server), the roots
   * are held back as `pendingRestore()` for the client to prompt on instead
   * of walking straight into the same crash.
   */
  async restorePersisted(): Promise<void> {
    if (!this.persistFile) return;
    const persisted = await this.loadStoredRoots();
    const alreadyOpen = new Set([...this.runtimes.values()].map((r) => r.root));
    const markerRoots = await this.readRestoreMarker();
    if (markerRoots) {
      // The marker's roots are what was being restored when the server died; a
      // corrupt/empty marker falls back to the persisted set. CLI-opened roots
      // are already live and proven harmless — only the rest are held back.
      const pending = (markerRoots.length > 0 ? markerRoots : persisted).filter(
        (r) => !alreadyOpen.has(r),
      );
      if (pending.length > 0) {
        this.safeModeRoots = pending;
        return;
      }
      await this.clearRestoreMarker();
    }
    await this.openGuarded(persisted.filter((r) => !alreadyOpen.has(r)));
  }

  /** Marker-guarded open loop: a hard crash mid-loop leaves the marker behind. */
  private async openGuarded(roots: string[]): Promise<void> {
    if (roots.length === 0) return;
    await this.writeRestoreMarker(roots);
    for (const root of roots) {
      try {
        await this.open(root);
      } catch (err) {
        console.warn(`[crystal] skipping persisted workspace ${root}:`, (err as Error).message);
      }
    }
    await this.clearRestoreMarker();
  }

  /**
   * Marker contents, or null when no marker exists (the last restore completed
   * cleanly). A marker that exists but doesn't parse still means a crashed
   * restore — it returns `[]` so the caller falls back to the persisted set.
   */
  private async readRestoreMarker(): Promise<string[] | null> {
    const marker = this.restoreMarkerFile();
    if (!marker) return null;
    let raw: string;
    try {
      raw = await fs.readFile(marker, "utf8");
    } catch {
      return null; // no marker — the previous restore finished
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.roots)) return [];
      return parsed.roots.filter((r: unknown) => typeof r === "string");
    } catch {
      return [];
    }
  }

  private async writeRestoreMarker(roots: string[]): Promise<void> {
    const marker = this.restoreMarkerFile();
    if (!marker) return;
    try {
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, JSON.stringify({ roots }, null, 2), "utf8");
    } catch (err) {
      console.warn("[crystal] could not write restore marker:", (err as Error).message);
    }
  }

  private async clearRestoreMarker(): Promise<void> {
    const marker = this.restoreMarkerFile();
    if (!marker) return;
    await fs.rm(marker, { force: true }).catch(() => {});
  }

  /** Roots held back by safe mode (see `restorePersisted`); null when none. */
  pendingRestore(): string[] | null {
    return this.safeModeRoots;
  }

  /**
   * Safe-mode "restore anyway": open the held-back roots. Marker-guarded, so
   * if the crash repeats the next boot prompts again rather than crash-looping.
   */
  async restorePending(): Promise<void> {
    const roots = this.safeModeRoots;
    this.safeModeRoots = null;
    if (!roots) return;
    const alreadyOpen = new Set([...this.runtimes.values()].map((r) => r.root));
    await this.openGuarded(roots.filter((r) => !alreadyOpen.has(r)));
    // open() broadcasts per root, but every root failing cleanly would leave
    // clients still showing the prompt — announce the resolution regardless.
    this.broadcast("workspaces.changed", {});
  }

  /**
   * Safe-mode "start without": drop the held-back roots from the open set
   * (they stay in recents, so nothing is lost) and clear the marker.
   */
  async dismissPendingRestore(): Promise<void> {
    if (!this.safeModeRoots) return;
    this.safeModeRoots = null;
    await this.clearRestoreMarker();
    // Overwrite the stored open set with what is actually open, so the
    // dropped roots don't come back on the next boot.
    await this.persist();
    this.broadcast("workspaces.changed", {});
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

  /**
   * Merge this server's in-memory reopen list with whatever is on disk
   * (read-modify-write): two servers appending recents must not drop each
   * other's entries. Newest `lastOpenedAt` wins per root; stored oldest-first
   * (map insertion order convention), trimmed to MAX_RECENTS.
   */
  private mergeRecentsWith(shared: Record<string, unknown>): RecentWorkspace[] {
    const byRoot = new Map<string, RecentWorkspace>();
    const consider = (r: RecentWorkspace) => {
      const prev = byRoot.get(r.root);
      if (!prev || prev.lastOpenedAt < r.lastOpenedAt) byRoot.set(r.root, r);
    };
    if (Array.isArray(shared.recents)) {
      for (const r of shared.recents) {
        if (typeof r?.root === "string" && typeof r?.name === "string" && typeof r?.lastOpenedAt === "string") {
          consider({ root: r.root, name: r.name, lastOpenedAt: r.lastOpenedAt });
        }
      }
    }
    for (const r of this.recentsByRoot.values()) consider(r);
    // ISO-8601 compares lexicographically; a stable sort keeps insertion order on ties.
    const merged = [...byRoot.values()].sort((a, b) =>
      a.lastOpenedAt < b.lastOpenedAt ? -1 : a.lastOpenedAt > b.lastOpenedAt ? 1 : 0,
    );
    return merged.slice(Math.max(0, merged.length - MAX_RECENTS));
  }

  private async persist(): Promise<void> {
    const file = this.persistFile;
    if (!file) return;
    // Loading first means a close() before any open() can't clobber stored recents.
    await this.ensureRecentsLoaded();
    // Snapshot the previous session's open set before overwriting it — the
    // boot-time CLI open persists before restorePersisted() gets to read.
    await this.loadStoredRoots();
    const roots = [...this.runtimes.values()].map((r) => r.root);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const readShared = async (): Promise<Record<string, unknown>> => {
        try {
          const parsed = JSON.parse(await fs.readFile(file, "utf8"));
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {}; // first run or unreadable — start fresh
        }
      };
      const flavor = this.flavorFile();
      if (flavor) {
        // This flavor's open set lives in its own file — a concurrent server
        // of another flavor never touches it.
        await fs.writeFile(flavor, JSON.stringify({ roots }, null, 2), "utf8");
        // Recents stay shared; the legacy `roots` field (and anything else in
        // the shared file) is preserved untouched for servers still reading it.
        const shared = await readShared();
        await fs.writeFile(
          file,
          JSON.stringify({ ...shared, recents: this.mergeRecentsWith(shared) }, null, 2),
          "utf8",
        );
      } else {
        // Legacy single-file layout: roots and recents together. Recents still
        // merge read-modify-write so even two legacy servers don't drop each
        // other's entries (roots remain last-writer, which the flavor key fixes).
        const shared = await readShared();
        await fs.writeFile(
          file,
          JSON.stringify({ ...shared, roots, recents: this.mergeRecentsWith(shared) }, null, 2),
          "utf8",
        );
      }
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
