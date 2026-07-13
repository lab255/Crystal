import crypto from "node:crypto";
import http from "node:http";
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
} from "@crystal/core";
import {
  applyCodeSnapshotToGraph,
  buildSystemOverview,
  computeReviewFindings,
  createArchDraft,
  diffSystemOverviews,
  suggestFacets,
} from "@crystal/core";
import { browseDirs } from "./browse.js";
import { createConsoleHandler, resolveConsoleDir } from "./console-static.js";
import { deleteAt, listDir, mkdirAt, readFileCapped, renameAt, writeFileAt } from "./fs-api.js";
import { changedFiles, gitCheckout, gitLog, gitRefs, gitStatus } from "./git.js";
import { handleMcpRequest, isMcpRequest } from "./mcp/http.js";
import { overviewSourcesAtRef, snapshotAtRef } from "./ref-snapshot.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

type Handlers = {
  [M in BridgeMethodName]: (
    params: BridgeMethods[M]["params"],
  ) => Promise<BridgeMethods[M]["result"]>;
};

export interface CrystalServer {
  port: number;
  close(): Promise<void>;
}

export async function startCrystalServer(opts: {
  /** Roots to open at startup; the first becomes the default workspace. */
  root: string | string[];
  port: number;
  /**
   * Interface to bind. Default `127.0.0.1` (loopback) keeps the server local
   * and unauthenticated. A non-loopback host (e.g. `0.0.0.0`) requires a token
   * — one is generated and printed if `token` is not supplied.
   */
  host?: string;
  /**
   * Bearer token gating the console + WS upgrade. `null`/omitted on a loopback
   * bind disables auth (preserves the desktop + `pnpm dev` experience).
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
}): Promise<CrystalServer> {
  // Declared ahead of the registry: opening the startup workspaces already
  // broadcasts, and `broadcast` (hoisted) closes over this set.
  const clients = new Set<WebSocket>();

  const registry = new WorkspaceRegistry(
    (event, payload) => broadcast(event, payload),
    opts.persistFile,
    // Manager runs reach the in-process MCP endpoint on this same server.
    `http://127.0.0.1:${opts.port}`,
  );

  // Open CLI roots first (first one is the default), then persisted ones.
  for (const root of Array.isArray(opts.root) ? opts.root : [opts.root]) {
    await registry.open(root);
  }
  if (opts.restorePersisted !== false) await registry.restorePersisted();

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
      await registry.get(ws).store.saveProject(p, project);
      return { ok: true };
    },
    "project.create": ({ ws, name }) => registry.get(ws).store.createProject(name),
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
    "git.changedFiles": ({ ws, repoPath, scope }) =>
      changedFiles(registry.get(ws).root, repoPath ?? ".", scope),
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
      terminal: registry.get(ws).terminals.create(cwd, cols, rows),
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
    "quality.detect": ({ ws }) => registry.get(ws).quality.detect(),
    "quality.run": ({ ws, ...params }) => registry.get(ws).quality.run(params),
    "quality.cancel": ({ ws, runId }) => registry.get(ws).quality.cancel(runId),
    "quality.runs": ({ ws }) => registry.get(ws).quality.runs(),
    "quality.coverage": ({ ws }) => registry.get(ws).quality.coverage(),
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

  // --- Networking: host bind, bearer-token auth, same-origin console ---
  const host = opts.host ?? "127.0.0.1";
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  let token = opts.token ?? null;
  if (!token && !isLoopback) {
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
        u.host === `${host}:${opts.port}` ||
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

  const httpServer = http.createServer((req, res) => {
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

  const wss = new WebSocketServer({
    server: httpServer,
    path: BRIDGE_PATH,
    verifyClient: (info, cb) => {
      if (!originAllowed(info.origin)) return cb(false, 403, "Forbidden");
      if (!tokenValid(tokenFromReq(info.req))) return cb(false, 401, "Unauthorized");
      cb(true);
    },
  });

  function broadcast<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    const msg: BridgeEventMessage<E> = { type: "evt", event, payload };
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (data) => {
      let req: BridgeRequest;
      try {
        req = JSON.parse(String(data)) as BridgeRequest;
      } catch {
        return;
      }
      if (req.type !== "req" || typeof req.method !== "string") return;
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
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => resolve());
  });

  const roots = registry.list().map((w) => path.resolve(w.root));
  console.log(
    `[crystal] bridge server on ws://${host}:${opts.port}${BRIDGE_PATH} (workspaces: ${roots.join(", ")})`,
  );
  if (authEnabled && !opts.token) {
    console.log(
      `\n[crystal] auth enabled — generated a session token (set CRYSTAL_TOKEN to pin one):\n\n` +
        `    ${token}\n\n` +
        `[crystal] open the console:  http://${host}:${opts.port}/?${BRIDGE_TOKEN_PARAM}=${token}\n`,
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

  return {
    port: opts.port,
    close: async () => {
      registry.closeAll();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
