import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  BRIDGE_PATH,
  BRIDGE_TOKEN_COOKIE,
  BRIDGE_TOKEN_PARAM,
  type BridgeEventMessage,
  type BridgeEventName,
  type BridgeEvents,
  type BridgeMethodName,
  type BridgeMethods,
  type BridgeRequest,
  type BridgeResponse,
  type ProgramSpend,
} from "@crystal/core";
import {
  applyCodeSnapshotToGraph,
  buildSystemOverview,
  computeReviewFindings,
  createArchDraft,
  diffSystemOverviews,
  openQuestionsOfWorkflow,
  suggestFacets,
} from "@crystal/core";
import { LineBuffer } from "@crystal/core";
import { browseDirs } from "./browse.js";
import { createConsoleHandler, resolveConsoleDir } from "./console-static.js";
import {
  claimPipePath,
  defaultInstancesDir,
  defaultPipePath,
  removeInstanceFile,
  unlinkPipe,
  writeInstanceFile,
} from "./instances.js";
import { AgentManager } from "./agent-manager.js";
import { HubEngine, type HubProjects } from "./hub-engine.js";
import { hubDataDir, workspaceIdFor } from "./paths.js";
import { deleteAt, listDir, mkdirAt, readFileCapped, renameAt, writeFileAt } from "./fs-api.js";
import { changedFiles, gitCheckout, gitLog, gitRefs, gitStatus } from "./git.js";
import { HUB_MCP_ID, handleMcpRequest, isMcpRequest } from "./mcp/http.js";
import { overviewSourcesAtRef, snapshotAtRef, surfacesSnapshotAtRef } from "./ref-snapshot.js";
import { pasteInput } from "./terminal-manager.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

/**
 * How long after spawning the Claude TUI its opening prompt is typed in. The
 * TUI must have mounted (and enabled bracketed paste) before raw input means
 * anything; too early and the paste markers land as literal escapes.
 */
const INTERACTIVE_PROMPT_DELAY_MS = 2500;

type Handlers = {
  [M in BridgeMethodName]: (
    params: BridgeMethods[M]["params"],
  ) => Promise<BridgeMethods[M]["result"]>;
};

export interface CrystalServer {
  /** TCP port of the opt-in network listener, null when IPC-only. */
  port: number | null;
  /** Loopback port of the always-on in-process MCP endpoint. */
  mcpPort: number;
  /** Endpoint a central agent points at to drive the cross-project hub. */
  hubMcpUrl: string;
  /** IPC endpoint (named pipe / unix socket), null when disabled. */
  pipe: string | null;
  close(): Promise<void>;
}

/** A connected bridge client, whatever transport it arrived on. */
interface RpcClient {
  send(text: string): void;
  close(): void;
}

/**
 * The hub's view of the workspace layer. Every cross-project action bottoms
 * out in an ordinary per-project operation — opening a workspace, starting a
 * workflow, messaging its manager — so the hub adds coordination without
 * adding a second execution path.
 */
function registryProjects(registry: WorkspaceRegistry): HubProjects {
  const ref = (rt: { id: string; root: string; name: string }) => ({
    ws: rt.id,
    root: rt.root,
    name: rt.name,
  });
  return {
    open: async (root) => ref(await registry.open(root)),
    list: () => registry.list().map((w) => ({ ws: w.id, root: w.root, name: w.name })),
    recents: () => registry.recents(),
    startWorkflow: async (ws, init) => (await registry.get(ws).workflows.start(init)).workflow,
    workflow: (ws, workflowId) => registry.get(ws).workflows.get(workflowId),
    // WorkflowSpend and DeliverySpend are the same four counters — a
    // delivery's spend IS its workflow's.
    workflowSpend: async (ws, workflowId) => {
      const rt = registry.get(ws);
      return (await rt.workflows.get(workflowId)) ? rt.workflows.spend(workflowId) : null;
    },
    messageWorkflow: async (ws, workflowId, text) => {
      const { queued } = await registry.get(ws).workflows.message(workflowId, text);
      return { queued };
    },
    setWorkflowPaused: async (ws, workflowId, paused, reason) => {
      await registry.get(ws).workflows.setPaused(workflowId, paused, reason);
    },
    setWorkflowBudget: async (ws, workflowId, budgetUsd) => {
      await registry.get(ws).workflows.setBudget(workflowId, budgetUsd);
    },
    cancelWorkflow: async (ws, workflowId) => {
      await registry.get(ws).workflows.cancel(workflowId);
    },
    boardSnapshot: async (ws) => {
      const rt = registry.get(ws);
      return rt.orchestration.snapshot(await rt.orchestration.projectPathFor(null));
    },
    openQuestions: async (ws, workflowId) => {
      const rt = registry.get(ws);
      const workflow = await rt.workflows.get(workflowId);
      if (!workflow) return [];
      // Only the boards: `store.load()` would also parse every architecture
      // and draft, and this runs on every board write.
      const projects = await rt.store.loadProjects();
      const project =
        projects.find((p) => p.project.id === workflow.projectId) ?? projects[0];
      if (!project) return [];
      return openQuestionsOfWorkflow(workflow, project.project.tasks).map((q) => ({
        taskId: q.task.id,
        taskTitle: q.task.title,
        questionId: q.question.id,
        text: q.question.text,
        createdAt: q.question.createdAt,
      }));
    },
    answerQuestion: async (ws, workflowId, taskId, questionId, answer) => {
      const rt = registry.get(ws);
      const workflow = await rt.workflows.get(workflowId);
      const projectPath = await rt.orchestration.projectPathFor(workflow?.projectId ?? null);
      return rt.orchestration.answerQuestion(projectPath, taskId, questionId, answer);
    },
  };
}

export async function startCrystalServer(opts: {
  /** Roots to open at startup; the first becomes the default workspace. */
  root: string | string[];
  /**
   * Opt-in TCP listener for the web console and remote access. When omitted
   * (the default) the bridge is reachable only over the local IPC pipe —
   * nothing for a firewall to flag. A non-loopback host requires a token —
   * one is generated and printed if `token` is not supplied.
   */
  listen?: { host?: string; port: number } | null;
  /**
   * IPC endpoint path (named pipe on Windows, unix socket elsewhere).
   * `undefined` derives one from the primary root; `null` disables IPC.
   */
  pipe?: string | null;
  /**
   * Bearer token gating the console + WS upgrade on the TCP listener.
   * `null`/omitted on a loopback bind disables auth (preserves the desktop +
   * `pnpm dev` experience). The IPC pipe trusts the OS user boundary instead.
   */
  token?: string | null;
  /**
   * Directory of the built web console to serve same-origin. `undefined`
   * auto-detects (`resolveConsoleDir`); `null` disables console serving.
   */
  consoleDir?: string | null;
  /** Also reopen workspaces persisted by a previous run (default true). */
  restorePersisted?: boolean;
  /** Override where the open-workspace set persists; null disables it. */
  persistFile?: string | null;
  /**
   * Directory for the instance discovery file (default
   * `~/.crystal/instances`); `null` disables discovery.
   */
  instancesDir?: string | null;
  /**
   * Pin the loopback MCP port instead of taking an ephemeral one. External
   * agents configure `POST http://127.0.0.1:<port>/mcp/hub` once and keep it
   * across restarts — an ephemeral port would move on every boot. Agent runs
   * spawned by Crystal never need this: their mcp-config is written per run.
   */
  mcpPort?: number | null;
  /** Where hub programs and program-manager runs persist (default `~/.crystal/hub`). */
  hubDir?: string | null;
}): Promise<CrystalServer> {
  // Declared ahead of the registry: opening the startup workspaces already
  // broadcasts, and `broadcast` (hoisted) closes over this set.
  const clients = new Set<RpcClient>();

  // --- MCP loopback listener, started first. Agent runs reach the in-process
  // MCP endpoint over plain HTTP (the Claude CLI can't dial a pipe), so a
  // small loopback-only server on an ephemeral port always exists; its
  // resolved port feeds the registry's MCP base URL. It serves nothing but
  // /health and /mcp — no console, no WS upgrade.
  let registryRef: WorkspaceRegistry | null = null;
  let hubRef: HubEngine | null = null;
  const mcpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (isMcpRequest(req.url) && registryRef) {
      const registry = registryRef;
      void handleMcpRequest(req, res, registry, hubRef).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: (err as Error).message },
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    mcpServer.once("error", reject);
    mcpServer.listen(opts.mcpPort ?? 0, "127.0.0.1", () => resolve());
  });
  const mcpPort = (mcpServer.address() as net.AddressInfo).port;
  const mcpBaseUrl = `http://127.0.0.1:${mcpPort}`;
  const hubMcpUrl = `${mcpBaseUrl}/mcp/${HUB_MCP_ID}`;

  const registry = new WorkspaceRegistry(
    (event, payload) => {
      // The hub watches every project's workflows: a delivery follows the
      // workflow carrying it. Routed through the broadcast seam so the hub
      // needs no per-runtime subscription lifecycle (workspaces close and
      // reopen with fresh engines).
      if (event === "workflow.changed") {
        const { ws, workflow } = payload as BridgeEvents["workflow.changed"];
        void hubRef?.onWorkflowChanged(ws, workflow).catch((err) => {
          console.warn("[crystal] hub workflow hook failed:", (err as Error).message);
        });
      }
      // Questions land on the board, not on the workflow — a board write is
      // the only signal that a delivery has stopped to ask something.
      if (event === "workspace.changed") {
        const { ws } = payload as BridgeEvents["workspace.changed"];
        hubRef?.scheduleQuestionSweep(ws);
      }
      // Interactive program managers run on workspace PTYs but their runs live
      // in the hub's agent host — no runtime would settle them on exit.
      if (event === "terminal.changed") {
        const { terminal } = payload as BridgeEvents["terminal.changed"];
        if (terminal.status === "exited") {
          void hubRef?.settleInteractiveManager(terminal.id, terminal.exitCode).catch((err) => {
            console.warn("[crystal] hub terminal settle failed:", (err as Error).message);
          });
        }
      }
      broadcast(event, payload);
    },
    opts.persistFile,
    mcpBaseUrl,
  );
  registryRef = registry;

  // Open CLI roots first (first one is the default), then persisted ones.
  for (const root of Array.isArray(opts.root) ? opts.root : [opts.root]) {
    await registry.open(root);
  }
  if (opts.restorePersisted !== false) await registry.restorePersisted();

  // --- The hub: cross-project programs. Its manager sessions are rooted in
  // the hub's own directory (they coordinate; they never edit a project), and
  // reach the hub toolset at /mcp/hub/<runId>.
  const hubRoot = opts.hubDir === undefined ? hubDataDir() : opts.hubDir;
  let hub: HubEngine | null = null;
  if (hubRoot) {
    await fs.mkdir(hubRoot, { recursive: true }).catch(() => {});
    const hubAgents = new AgentManager(hubRoot, hubRoot, undefined, {
      baseUrl: mcpBaseUrl,
      scope: HUB_MCP_ID,
    });
    hubAgents.events.on("runChanged", ({ run }) => broadcast("hub.runChanged", { run }));
    hubAgents.events.on("event", (event) => broadcast("hub.event", event));
    // Interactive managers live on a workspace PTY (`terminalWs`) — the hub's
    // agent host reaches it through the registry.
    hubAgents.interactiveInput = (run, text) => {
      if (!run.terminalId || !run.terminalWs) return false;
      try {
        registry.get(run.terminalWs).terminals.input(run.terminalId, pasteInput(text));
        return true;
      } catch {
        return false;
      }
    };
    hubAgents.interactiveKill = (run) => {
      if (!run.terminalId || !run.terminalWs) return;
      try {
        registry.get(run.terminalWs).terminals.kill(run.terminalId);
      } catch {
        // workspace closed or terminal already gone
      }
    };
    hub = new HubEngine(hubRoot, registryProjects(registry), hubAgents);
    hub.events.on("changed", ({ program }) => broadcast("hub.changed", { program }));
    // Catch up on anything that settled while this server was down — the hub's
    // event edges only cover the time it was actually listening.
    void hub.reconcile().catch((err) => {
      console.warn("[crystal] hub reconcile failed:", (err as Error).message);
    });
    hub.events.on("removed", ({ programId }) => broadcast("hub.removed", { programId }));
    hub.events.on("questionsChanged", (payload) => broadcast("hub.questionsChanged", payload));
    hubRef = hub;
  }
  /** Narrows "the hub is configured" for the handler map. */
  const requireHub = (): HubEngine => {
    if (!hub) throw new Error("The cross-project hub is disabled on this server.");
    return hub;
  };

  const handlers: Handlers = {
    "workspaces.list": async () => ({
      workspaces: registry.list(),
      defaultWs: registry.defaultWs,
      recents: await registry.recents(),
    }),
    "workspaces.open": async ({ root }) => ({
      workspace: (await registry.open(root)).descriptor(),
    }),
    "workspaces.close": async ({ ws }) => {
      await registry.close(ws);
      return { ok: true };
    },
    "workspaces.browse": ({ path: p }) => browseDirs(p),
    "workspace.get": async ({ ws }) => {
      const rt = registry.get(ws);
      const info = await rt.store.load();
      rt.name = info.manifest.name;
      return info;
    },
    "workspace.saveManifest": async ({ ws, manifest }) => {
      const rt = registry.get(ws);
      await rt.store.saveManifest(manifest);
      if (rt.name !== manifest.name) {
        rt.name = manifest.name;
        broadcast("workspaces.changed", {});
      }
      broadcast("workspace.changed", { ws: rt.id });
      return { ok: true };
    },
    "arch.save": async ({ ws, path: p, graph }) => {
      await registry.get(ws).store.saveArchitecture(p, graph);
      return { ok: true };
    },
    "arch.create": ({ ws, name }) => registry.get(ws).store.createArchitecture(name),
    "arch.delete": async ({ ws, path: p }) => {
      const rt = registry.get(ws);
      await rt.store.deleteArchitecture(p);
      broadcast("workspace.changed", { ws: rt.id });
      return { ok: true };
    },
    "archdraft.create": ({ ws, draft }) => registry.get(ws).store.createArchDraft(draft),
    "archdraft.fromRef": async ({ ws, archPath, ref, repoPath }) => {
      const rt = registry.get(ws);
      const info = await rt.store.load();
      const arch = info.architectures.find((a) => a.path === archPath);
      if (!arch) throw new Error(`Unknown architecture: ${archPath}`);
      const snapshot = await snapshotAtRef(rt.root, repoPath ?? ".", ref);
      // Long hashes make unreadable names; prefer the resolved short hash.
      const refLabel = /^[0-9a-f]{12,}$/i.test(ref) ? snapshot.commit : ref;
      const draft = createArchDraft(
        `Review ${refLabel}`,
        archPath,
        arch.graph,
        new Date().toISOString(),
      );
      const graph = applyCodeSnapshotToGraph(arch.graph, snapshot);
      const created = await rt.store.createArchDraft({ ...draft, graph });
      broadcast("workspace.changed", { ws: rt.id });
      return created;
    },
    "archdraft.save": async ({ ws, path: p, draft }) => {
      await registry.get(ws).store.saveArchDraft(p, draft);
      return { ok: true };
    },
    "archdraft.delete": async ({ ws, path: p }) => {
      const rt = registry.get(ws);
      await rt.store.deleteArchDraft(p);
      broadcast("workspace.changed", { ws: rt.id });
      return { ok: true };
    },
    "project.save": async ({ ws, path: p, project }) => {
      // Guarded: leases and cost rollups are server-owned — a stale client
      // snapshot must not clobber a live claim or a billed epic.
      await registry.get(ws).orchestration.saveProjectGuarded(p, project);
      return { ok: true };
    },
    "project.create": ({ ws, name }) => registry.get(ws).store.createProject(name),
    "task.claim": ({ ws, path: p, taskId, holder, holderRunId, claimId, ttlSeconds }) =>
      registry.get(ws).orchestration.claimTask(p, taskId, {
        holder,
        holderRunId,
        claimId,
        ttlMs: ttlSeconds != null ? ttlSeconds * 1000 : undefined,
      }),
    "task.release": ({ ws, path: p, taskId, claimId, force }) =>
      registry.get(ws).orchestration.releaseTask(p, taskId, { claimId, force }),
    "task.answer": ({ ws, path: p, taskId, questionId, answer }) =>
      registry.get(ws).orchestration.answerQuestion(p, taskId, questionId, answer),
    "task.update": ({ ws, path: p, taskId, patch, claimId, force }) =>
      registry.get(ws).orchestration.updateTask(p, taskId, patch, { claimId, force }),
    "agents.get": async ({ ws }) => ({ roster: await registry.get(ws).store.loadAgents() }),
    "agents.save": async ({ ws, roster }) => {
      const rt = registry.get(ws);
      await rt.store.saveAgents(roster);
      broadcast("agents.changed", { ws: rt.id, roster });
      return { ok: true };
    },
    "syslayout.get": async ({ ws }) => ({
      layout: await registry.get(ws).store.loadSystemsLayout(),
    }),
    "syslayout.save": async ({ ws, layout }) => {
      await registry.get(ws).store.saveSystemsLayout(layout);
      return { ok: true };
    },
    "facets.get": async ({ ws }) => ({ facets: await registry.get(ws).store.loadFacets() }),
    "facets.save": async ({ ws, facets }) => {
      await registry.get(ws).store.saveFacets(facets);
      return { ok: true };
    },
    "todos.get": async ({ ws }) => ({ todos: await registry.get(ws).store.loadTodos() }),
    "todos.save": async ({ ws, todos }) => {
      const rt = registry.get(ws);
      await rt.store.saveTodos(todos);
      broadcast("todos.changed", { ws: rt.id, todos });
      return { ok: true };
    },
    "fs.list": async ({ ws, path: p }) => ({
      entries: await listDir(registry.get(ws).root, p),
    }),
    "fs.read": ({ ws, path: p }) => readFileCapped(registry.get(ws).root, p),
    "fs.write": async ({ ws, path: p, content }) => {
      await writeFileAt(registry.get(ws).root, p, content);
      return { ok: true };
    },
    "fs.mkdir": async ({ ws, path: p }) => {
      await mkdirAt(registry.get(ws).root, p);
      return { ok: true };
    },
    "fs.rename": async ({ ws, from, to }) => {
      await renameAt(registry.get(ws).root, from, to);
      return { ok: true };
    },
    "fs.delete": async ({ ws, path: p }) => {
      await deleteAt(registry.get(ws).root, p);
      return { ok: true };
    },
    "git.status": ({ ws, repoPath }) => gitStatus(registry.get(ws).root, repoPath),
    "git.log": ({ ws, repoPath, limit }) => gitLog(registry.get(ws).root, repoPath ?? ".", limit),
    "git.changedFiles": ({ ws, repoPath, scope, ref }) =>
      changedFiles(registry.get(ws).root, repoPath ?? ".", scope, ref),
    "git.refs": ({ ws, repoPath }) => gitRefs(registry.get(ws).root, repoPath ?? "."),
    "git.checkout": ({ ws, repoPath, ref }) =>
      gitCheckout(registry.get(ws).root, repoPath ?? ".", ref),
    "agent.start": async ({ ws, ...params }) => {
      const rt = registry.get(ws);
      // Resolve the dispatch profile server-side so model + skills always
      // follow the roster on disk, whatever the client knew.
      let model: string | null = null;
      let skills: string[] = [];
      if (params.agentId) {
        const roster = await rt.store.loadAgents();
        const profile = roster.agents.find((a) => a.id === params.agentId);
        if (profile) {
          model = profile.model;
          skills = profile.skills;
        }
      }
      return { run: await rt.agents.start({ ...params, model, skills }) };
    },
    "agent.interactive": async ({ ws, cols, rows, ...params }) => {
      const rt = registry.get(ws);
      let model: string | null = null;
      let skills: string[] = [];
      if (params.agentId) {
        const roster = await rt.store.loadAgents();
        const profile = roster.agents.find((a) => a.id === params.agentId);
        if (profile) {
          model = profile.model;
          skills = profile.skills;
        }
      }
      const plan = await rt.agents.prepareInteractive({ ...params, model, skills });
      const terminal = rt.terminals.create({
        cwd: plan.cwd,
        cols,
        rows,
        command: { file: plan.file, args: plan.args, env: plan.env },
        title: ["claude", params.purpose ?? null].filter(Boolean).join(" · "),
      });
      const run = await rt.agents.bindInteractive(plan.run.id, terminal.id);
      if (terminal.status === "exited") {
        // Spawn failed before the exit event could see a bound run.
        await rt.agents.settleInteractive(terminal.id, terminal.exitCode);
        return { run: (await rt.agents.get(run.id)) ?? run, terminal };
      }
      rt.terminals.writeWhenReady(terminal.id, plan.prompt, INTERACTIVE_PROMPT_DELAY_MS);
      return { run, terminal };
    },
    "agent.dispatchWorker": async ({ ws, managerRunId, spec }) => {
      const run = await registry.get(ws).agents.dispatchWorker(managerRunId, spec);
      return { run };
    },
    "agent.cancel": async ({ ws, runId }) => {
      await registry.get(ws).agents.cancel(runId);
      return { ok: true };
    },
    "agent.list": async ({ ws }) => ({ runs: await registry.get(ws).agents.list() }),
    "agent.events": async ({ ws, runId }) => ({
      events: await registry.get(ws).agents.eventsFor(runId),
    }),
    "agent.diff": ({ ws, runId }) => registry.get(ws).agents.diff(runId),
    "agent.cleanupWorktree": async ({ ws, runId }) => {
      await registry.get(ws).agents.cleanupWorktree(runId);
      return { ok: true };
    },
    "terminal.create": async ({ ws, cwd, cols, rows }) => ({
      terminal: registry.get(ws).terminals.create({ cwd, cols, rows }),
    }),
    "terminal.list": async ({ ws }) => ({ terminals: registry.get(ws).terminals.list() }),
    "terminal.input": async ({ ws, terminalId, data }) => {
      registry.get(ws).terminals.input(terminalId, data);
      return { ok: true };
    },
    "terminal.resize": async ({ ws, terminalId, cols, rows }) => {
      registry.get(ws).terminals.resize(terminalId, cols, rows);
      return { ok: true };
    },
    "terminal.kill": async ({ ws, terminalId }) => {
      registry.get(ws).terminals.kill(terminalId);
      return { ok: true };
    },
    "terminal.buffer": async ({ ws, terminalId }) => ({
      chunks: registry.get(ws).terminals.buffer(terminalId),
    }),
    "codemap.get": ({ ws }) => registry.get(ws).codemap.summary(),
    "codemap.module": ({ ws, path: p, prefer }) =>
      registry.get(ws).codemap.moduleDetail(p, prefer),
    "codemap.file": ({ ws, path: p }) => registry.get(ws).codemap.fileDetail(p),
    "codemap.details": ({ ws, modules, prefer }) =>
      registry.get(ws).codemap.bulkDetails(modules, prefer),
    "codemap.cross": () => registry.crossMap(),
    "codemap.overview": async ({ ws }) => {
      const rt = registry.get(ws);
      const [sources, { index }] = await Promise.all([
        rt.codemap.overviewSourceFiles(),
        rt.codeindex.get(),
      ]);
      return {
        ...buildSystemOverview(sources, index),
        generatedAt: new Date().toISOString(),
      };
    },
    "codemap.overviewDiff": async ({ ws, ref, repoPath }) => {
      const rt = registry.get(ws);
      const [headSources, { index }, atRef] = await Promise.all([
        rt.codemap.overviewSourceFiles(),
        rt.codeindex.get(),
        overviewSourcesAtRef(rt.root, repoPath ?? ".", ref),
      ]);
      const generatedAt = new Date().toISOString();
      const head = { ...buildSystemOverview(headSources, index), generatedAt };
      const base = { ...buildSystemOverview(atRef.sources, index), generatedAt };
      return { ref, commit: atRef.commit, base, head, diff: diffSystemOverviews(base, head) };
    },
    "codemap.symbolSource": ({ ws, file, symbol }) =>
      registry.get(ws).codemap.symbolSource(file, symbol),
    "codemap.symbolSites": ({ ws, file, symbol }) =>
      registry.get(ws).codemap.symbolSites(file, symbol),
    "codemap.partCrossings": ({ ws, sourcePart, targetPart, sourceParts, targetParts }) =>
      registry.get(ws).codemap.partCrossings(sourcePart, targetPart, sourceParts, targetParts),
    "codemap.trace": ({ ws, file, symbol, maxDepth }) =>
      registry.get(ws).codemap.trace(file, symbol, maxDepth),
    "codemap.apiTrace": ({ ws, file, symbol, maxDepth }) =>
      registry.get(ws).codemap.apiTrace(file, symbol, maxDepth),
    "codemap.changes": ({ ws, sinceHours }) => registry.get(ws).codemap.changes(sinceHours),
    "codemap.duplicates": async ({ ws, minTokens }) => ({
      clusters: await registry.get(ws).codemap.duplicates(minTokens),
      generatedAt: new Date().toISOString(),
    }),
    "codemap.journeys": async ({ ws, limit }) => ({
      suggestions: await registry.get(ws).codemap.suggestJourneys(limit),
      generatedAt: new Date().toISOString(),
    }),
    "codemap.symbols": async ({ ws, query, limit }) => ({
      symbols: await registry.get(ws).codemap.searchSymbols(query, limit),
    }),
    "codemap.apiSites": ({ ws, method, path: p }) => registry.get(ws).codemap.apiSites(method, p),
    "codeindex.get": ({ ws }) => registry.get(ws).codeindex.get(),
    "codeindex.enrich": async ({ ws, files, full, agentId }) => {
      const rt = registry.get(ws);
      // Indexing defaults to a small, cheap model; a profile overrides it.
      let model = "haiku";
      let skills: string[] = [];
      if (agentId) {
        const roster = await rt.store.loadAgents();
        const profile = roster.agents.find((a) => a.id === agentId);
        if (profile) {
          model = profile.model;
          skills = profile.skills;
        }
      }
      const startBatch = async () => {
        const dispatch = await rt.codeindex.enrichmentDispatch(full ? undefined : files);
        const run = await rt.agents.start({
          prompt: dispatch.prompt,
          model,
          skills,
          agentId: agentId ?? null,
          purpose: "index",
          tags: ["purpose:index"],
        });
        return { run, files: dispatch.files, remaining: dispatch.remaining };
      };
      // A full index chains batches server-side until the backlog is drained.
      if (full) return rt.codeindex.drainBacklog(startBatch, (id) => rt.agents.waitForSettled(id));
      return startBatch();
    },
    "review.findings": async ({ ws }) => {
      const rt = registry.get(ws);
      const [files, clusters, { index }] = await Promise.all([
        rt.codemap.reviewSourceFiles(),
        rt.codemap.duplicates(),
        rt.codeindex.get(),
      ]);
      return {
        findings: computeReviewFindings(files, clusters, index),
        generatedAt: new Date().toISOString(),
      };
    },
    "arch.suggestFacets": async ({ ws, path: p }) => {
      const rt = registry.get(ws);
      const info = await rt.store.load();
      const arch = info.architectures.find((a) => a.path === p);
      if (!arch) throw new Error(`Unknown architecture: ${p}`);
      const { index } = await rt.codeindex.get();
      return { suggestions: suggestFacets(arch.graph, index) };
    },
    "surfaces.get": ({ ws }) => registry.get(ws).codemap.surfaces(),
    "surfaces.map": ({ ws }) => registry.get(ws).codemap.surfaceMap(),
    "surfaces.atRef": async ({ ws, ref, repoPath }) => {
      const rt = registry.get(ws);
      const [{ index }, snap] = await Promise.all([
        rt.codeindex.get(),
        surfacesSnapshotAtRef(rt.root, repoPath ?? ".", ref),
      ]);
      // The head's semantic index clusters both sides — same convention as
      // `codemap.overviewDiff`, so system ids stay comparable across refs.
      const overview = {
        ...buildSystemOverview(snap.sources, index),
        generatedAt: new Date().toISOString(),
      };
      return { ref, commit: snap.commit, report: snap.report, overview, calls: snap.calls };
    },
    "quality.detect": ({ ws }) => registry.get(ws).quality.detect(),
    "quality.run": ({ ws, ...params }) => registry.get(ws).quality.run(params),
    "quality.cancel": ({ ws, runId }) => registry.get(ws).quality.cancel(runId),
    "quality.runs": ({ ws }) => registry.get(ws).quality.runs(),
    "quality.coverage": ({ ws }) => registry.get(ws).quality.coverage(),
    "workflow.start": ({ ws, ...params }) => registry.get(ws).workflows.start(params),
    "workflow.list": async ({ ws }) => ({
      workflows: await registry.get(ws).workflows.list(),
    }),
    "workflow.get": async ({ ws, workflowId }) => {
      const rt = registry.get(ws);
      const workflow = await rt.workflows.get(workflowId);
      if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
      return { workflow, spend: await rt.workflows.spend(workflowId) };
    },
    "workflow.message": ({ ws, workflowId, text }) =>
      registry.get(ws).workflows.message(workflowId, text),
    "workflow.setPaused": async ({ ws, workflowId, paused, reason }) => ({
      workflow: await registry.get(ws).workflows.setPaused(workflowId, paused, reason),
    }),
    "workflow.setBudget": async ({ ws, workflowId, budgetUsd }) => ({
      workflow: await registry.get(ws).workflows.setBudget(workflowId, budgetUsd),
    }),
    "workflow.cancel": async ({ ws, workflowId }) => ({
      workflow: await registry.get(ws).workflows.cancel(workflowId),
    }),
    "workflow.templates": async ({ ws }) => ({
      templates: await registry.get(ws).workflows.listTemplates(),
    }),
    "workflow.saveTemplate": async ({ ws, template, scope }) => ({
      template: await registry.get(ws).workflows.saveTemplate(template, scope),
    }),
    "workflow.deleteTemplate": async ({ ws, templateId }) => {
      await registry.get(ws).workflows.deleteTemplate(templateId);
      return { ok: true as const };
    },
    "hub.list": async () => {
      const engine = requireHub();
      const [programs, managerRuns] = await Promise.all([engine.list(), engine.managerRuns()]);
      const spend: Record<string, ProgramSpend> = {};
      await Promise.all(
        programs.map(async (p) => {
          spend[p.id] = await engine.spend(p.id, managerRuns);
        }),
      );
      return { programs, spend };
    },
    "hub.get": async ({ programId }) => {
      const program = await requireHub().get(programId);
      if (!program) throw new Error(`Unknown program: ${programId}`);
      return { program, spend: await requireHub().spend(programId) };
    },
    "hub.projects": () => requireHub().projectList(),
    "hub.createProgram": async (params) => ({ program: await requireHub().create(params) }),
    "hub.addDelivery": async ({ programId, ...init }) => ({
      delivery: await requireHub().addDelivery(programId, init),
    }),
    "hub.removeDelivery": async ({ programId, deliveryId }) => {
      await requireHub().removeDelivery(programId, deliveryId);
      return { ok: true as const };
    },
    "hub.retryDelivery": async ({ programId, deliveryId }) => ({
      program: await requireHub().retryDelivery(programId, deliveryId),
    }),
    "hub.dispatch": async ({ programId, deliveryIds }) => ({
      report: await requireHub().dispatch(programId, deliveryIds),
    }),
    "hub.dispatchEpic": (params) => requireHub().dispatchEpic(params),
    "hub.messageDelivery": ({ programId, deliveryId, text }) =>
      requireHub().messageDelivery(programId, deliveryId, text),
    "hub.setPaused": async ({ programId, paused, reason }) => ({
      program: await requireHub().setPaused(programId, paused, reason),
    }),
    "hub.setBudget": async ({ programId, budgetUsd }) => ({
      program: await requireHub().setBudget(programId, budgetUsd),
    }),
    "hub.setDeliveryBudget": async ({ programId, deliveryId, budgetUsd }) => ({
      program: await requireHub().setDeliveryBudget(programId, deliveryId, budgetUsd),
    }),
    "hub.cancel": async ({ programId }) => ({ program: await requireHub().cancel(programId) }),
    "hub.remove": async ({ programId }) => {
      await requireHub().remove(programId);
      return { ok: true as const };
    },
    "hub.startManager": async ({ programId, model, terminal }) => {
      const engine = requireHub();
      let run;
      if (terminal) {
        // Interactive manager: the hub owns the run, a workspace hosts the PTY.
        const rt = registry.get(terminal.ws);
        const plan = await engine.prepareInteractiveManager(programId, model ?? "opus");
        const term = rt.terminals.create({
          cols: terminal.cols,
          rows: terminal.rows,
          command: { file: plan.file, args: plan.args, env: plan.env },
          title: "program manager",
        });
        run = await engine.bindManagerTerminal(plan.run.id, term.id, rt.id);
        if (term.status === "exited") {
          await engine.settleInteractiveManager(term.id, term.exitCode);
        } else {
          rt.terminals.writeWhenReady(term.id, plan.prompt, INTERACTIVE_PROMPT_DELAY_MS);
        }
      } else {
        run = await engine.startManager(programId, model ?? "opus");
      }
      const program = await engine.get(programId);
      if (!program) throw new Error(`Unknown program: ${programId}`);
      return { program, run };
    },
    "hub.message": ({ programId, text }) => requireHub().message(programId, text),
    "hub.questions": async () => ({ questions: await requireHub().allQuestions() }),
    "hub.answerQuestion": ({ programId, questionId, answer }) =>
      requireHub().answerQuestion(programId, questionId, answer),
    "hub.endpoint": async () => ({
      url: hubMcpUrl,
      mcpConfig: JSON.stringify(
        { mcpServers: { "crystal-hub": { type: "http", url: hubMcpUrl } } },
        null,
        2,
      ),
    }),
    "hub.runs": async () => ({ runs: await requireHub().managerRuns() }),
    "hub.runEvents": async ({ runId }) => ({ events: await requireHub().managerRunEvents(runId) }),
    "hub.cancelRun": async ({ runId }) => {
      await requireHub().cancelManagerRun(runId);
      return { ok: true as const };
    },
    "refactor.preview": ({ ws, intents }) => registry.get(ws).refactor().preview(intents),
    "refactor.apply": async ({ ws, intents }) => {
      const rt = registry.get(ws);
      const { applied, failed, pathsTouched } = await rt.refactor().apply(intents);
      if (pathsTouched.length > 0) {
        // The watcher would catch these in 250ms; explicit keeps the UI snappy.
        rt.codemap.invalidate();
        broadcast("fs.changed", { ws: rt.id, paths: pathsTouched });
        broadcast("codemap.changed", { ws: rt.id });
      }
      return { applied, failed };
    },
  };

  // --- Networking: opt-in TCP bind, bearer-token auth, same-origin console ---
  const listen = opts.listen ?? null;
  const host = listen?.host ?? "127.0.0.1";
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  let token = opts.token ?? null;
  if (!token && listen && !isLoopback) {
    // Refuse to expose fs/git/terminal/agent execution on a public interface
    // with no credential — mint one so remote binds are never wide open.
    token = crypto.randomBytes(32).toString("base64url");
  }
  const authEnabled = token !== null;

  const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
  // Hash both sides to a fixed length before comparing: `timingSafeEqual`
  // throws on length mismatch and would otherwise leak the token length.
  const tokenValid = (candidate: string | null): boolean => {
    if (!token) return true; // auth disabled (loopback, no token)
    if (!candidate) return false;
    return crypto.timingSafeEqual(digest(candidate), digest(token));
  };
  const tokenFromReq = (req: http.IncomingMessage): string | null => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get(BRIDGE_TOKEN_PARAM);
    if (q) return q;
    const auth = req.headers.authorization; // non-browser clients (CLI, tests)
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    const cookie = req.headers.cookie ?? ""; // browser, after the console load
    const m = new RegExp(`(?:^|;\\s*)${BRIDGE_TOKEN_COOKIE}=([^;]+)`).exec(cookie);
    return m ? decodeURIComponent(m[1]!) : null;
  };
  // `ws` doesn't check Origin, so any web page could open our socket. Reject
  // cross-origin upgrades (a token alone wouldn't stop a same-machine browser).
  const originAllowed = (origin: string | undefined): boolean => {
    if (!origin) return true; // native/non-browser clients send no Origin
    const allow = process.env.CRYSTAL_ALLOWED_ORIGINS;
    if (allow) return allow.split(",").map((s) => s.trim()).includes(origin);
    try {
      const u = new URL(origin);
      return (
        (listen != null && u.host === `${host}:${listen.port}`) ||
        u.hostname === host ||
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        // Tauri desktop serves the app from `tauri.localhost` (Windows
        // WebView2). All `*.localhost` names are loopback-reserved (RFC 6761),
        // so this is the same trust boundary as the bridge itself.
        u.hostname.endsWith(".localhost")
      );
    } catch {
      return false;
    }
  };

  const consoleDir = opts.consoleDir === undefined ? resolveConsoleDir() : opts.consoleDir;
  const serveConsole = createConsoleHandler(consoleDir);

  const httpServer = !listen
    ? null
    : http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Health stays unauthenticated for readiness probes / load balancers, but
    // must not leak absolute host paths once a token is configured.
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          authEnabled ? { ok: true } : { ok: true, roots: registry.list().map((w) => w.root) },
        ),
      );
      return;
    }
    if (isMcpRequest(req.url)) {
      void handleMcpRequest(req, res, registry).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: (err as Error).message },
          }),
        );
      });
      return;
    }

    // Console-load handshake: a valid `?token=` is promoted to an HttpOnly
    // cookie and redirected away, so the token leaves the address bar/history
    // and never reaches app JS. Assets + the WS upgrade then use the cookie.
    const queryToken = url.searchParams.get(BRIDGE_TOKEN_PARAM);
    if (authEnabled && queryToken && tokenValid(queryToken)) {
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      url.searchParams.delete(BRIDGE_TOKEN_PARAM);
      res.writeHead(302, {
        "set-cookie": `${BRIDGE_TOKEN_COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
        location: url.pathname + url.search,
      });
      res.end();
      return;
    }

    // Everything else (the console shell + its assets) is token-gated.
    if (!tokenValid(tokenFromReq(req))) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    serveConsole(req, res);
  });

  function broadcast<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    const msg: BridgeEventMessage<E> = { type: "evt", event, payload };
    const text = JSON.stringify(msg);
    for (const client of clients) client.send(text);
  }

  /** Parse one request frame and produce the response frame (null = not a request). */
  async function dispatchRaw(raw: string): Promise<string | null> {
    let req: BridgeRequest;
    try {
      req = JSON.parse(raw) as BridgeRequest;
    } catch {
      return null;
    }
    if (req.type !== "req" || typeof req.method !== "string") return null;
    const handler = handlers[req.method as BridgeMethodName] as
      | ((params: unknown) => Promise<unknown>)
      | undefined;
    let res: BridgeResponse;
    if (!handler) {
      res = {
        id: req.id,
        type: "res",
        ok: false,
        error: { message: `Unknown method: ${req.method}`, code: "unknown_method" },
      };
    } else {
      try {
        const result = await handler(req.params);
        res = { id: req.id, type: "res", ok: true, result } as BridgeResponse;
      } catch (err) {
        res = {
          id: req.id,
          type: "res",
          ok: false,
          error: { message: (err as Error).message },
        };
      }
    }
    return JSON.stringify(res);
  }

  const wss = !httpServer
    ? null
    : new WebSocketServer({
        server: httpServer,
        path: BRIDGE_PATH,
        verifyClient: (info, cb) => {
          if (!originAllowed(info.origin)) return cb(false, 403, "Forbidden");
          if (!tokenValid(tokenFromReq(info.req))) return cb(false, 401, "Unauthorized");
          cb(true);
        },
      });

  wss?.on("connection", (ws) => {
    const client: RpcClient = {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: () => ws.terminate(),
    };
    clients.add(client);
    ws.on("close", () => clients.delete(client));
    ws.on("message", async (data) => {
      const res = await dispatchRaw(String(data));
      if (res) client.send(res);
    });
  });

  // --- IPC pipe: the default local transport. Same request/response/event
  // frames as the WebSocket, newline-delimited (JSON.stringify never emits a
  // raw newline, so line framing is safe). Native clients — the desktop
  // shell's relay, CLI tools — connect here; browsers use the TCP listener.
  const instDir = opts.instancesDir === undefined ? defaultInstancesDir() : opts.instancesDir;
  let pipePath: string | null = null;
  let pipeServer: net.Server | null = null;
  if (opts.pipe !== null) {
    const primaryRoot = Array.isArray(opts.root) ? opts.root[0]! : opts.root;
    const primaryId = workspaceIdFor(primaryRoot);
    pipePath =
      opts.pipe ??
      (await claimPipePath(
        defaultPipePath(primaryId),
        // Second server on the same root (or a foreign pipe squatting the
        // name): fall back to a pid-unique endpoint.
        defaultPipePath(`${primaryId}-${process.pid}`),
        instDir,
      ));
    const server = net.createServer((socket) => {
      const client: RpcClient = {
        send: (text) => {
          if (!socket.destroyed) socket.write(text + "\n");
        },
        close: () => socket.destroy(),
      };
      clients.add(client);
      const lines = new LineBuffer();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) {
          void dispatchRaw(line).then((res) => {
            if (res) client.send(res);
          });
        }
      });
      const drop = () => {
        clients.delete(client);
        socket.destroy();
      };
      socket.on("close", drop);
      socket.on("error", drop);
    });
    pipeServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath!, () => resolve());
    });
  }

  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(listen!.port, host, () => resolve());
    });
  }

  // Advertise the endpoints for local discovery (desktop shell, CLI tools).
  let instanceFile: string | null = null;
  if (instDir) {
    try {
      instanceFile = await writeInstanceFile(instDir, {
        pid: process.pid,
        pipe: pipePath,
        port: listen?.port ?? null,
        mcpPort,
        ...(hub ? { hubMcpUrl } : {}),
        roots: registry.list().map((w) => w.root),
        ...(token ? { token } : {}),
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[crystal] could not write instance file:", (err as Error).message);
    }
  }

  const roots = registry.list().map((w) => path.resolve(w.root));
  if (pipePath) {
    console.log(`[crystal] bridge on ipc:${pipePath} (workspaces: ${roots.join(", ")})`);
  }
  console.log(`[crystal] mcp endpoint on ${mcpBaseUrl}/mcp (loopback only)`);
  if (hub) {
    console.log(
      `[crystal] cross-project hub on ${hubMcpUrl} — point a central agent at it:\n` +
        `    claude mcp add --transport http crystal-hub ${hubMcpUrl}` +
        (opts.mcpPort ? "" : `\n    (ephemeral port — pass --mcp-port <port> to pin it across restarts)`),
    );
  }
  if (listen) {
    console.log(`[crystal] bridge server on ws://${host}:${listen.port}${BRIDGE_PATH}`);
    if (authEnabled && !opts.token) {
      console.log(
        `\n[crystal] auth enabled — generated a session token (set CRYSTAL_TOKEN to pin one):\n\n` +
          `    ${token}\n\n` +
          `[crystal] open the console:  http://${host}:${listen.port}/?${BRIDGE_TOKEN_PARAM}=${token}\n`,
      );
    } else if (authEnabled) {
      console.log(`[crystal] auth enabled (token from CRYSTAL_TOKEN)`);
    } else {
      console.log(`[crystal] auth disabled — loopback bind, no token required`);
    }
    if (consoleDir) {
      console.log(`[crystal] serving web console from ${consoleDir}`);
    } else {
      console.log(
        `[crystal] web console bundle not found — serving API only ` +
          `(build @crystal/web or set CRYSTAL_CONSOLE_DIR)`,
      );
    }
  } else if (!pipePath) {
    console.warn(`[crystal] no bridge listener configured (pipe disabled, no --listen)`);
  }

  return {
    port: listen?.port ?? null,
    mcpPort,
    hubMcpUrl,
    pipe: pipePath,
    close: async () => {
      hub?.dispose();
      registry.closeAll();
      if (instanceFile) await removeInstanceFile(instanceFile);
      // Server .close() waits for open connections — drop live clients first
      // so shutdown can't hang on an idle browser tab or a wedged pipe.
      for (const client of clients) client.close();
      clients.clear();
      wss?.close();
      httpServer?.closeAllConnections();
      mcpServer.closeAllConnections();
      const stop = (s: http.Server | net.Server | null) =>
        new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
      await Promise.all([stop(httpServer), stop(pipeServer), stop(mcpServer)]);
      // A unix socket file outlives its server; named pipes clean up themselves.
      if (pipePath) await unlinkPipe(pipePath);
    },
  };
}
