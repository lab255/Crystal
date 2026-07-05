import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  BRIDGE_PATH,
  type BridgeEventMessage,
  type BridgeEventName,
  type BridgeEvents,
  type BridgeMethodName,
  type BridgeMethods,
  type BridgeRequest,
  type BridgeResponse,
} from "@crystal/core";
import { AgentManager } from "./agent-manager.js";
import { CodeMapAnalyzer } from "./code-map.js";
import { deleteAt, listDir, mkdirAt, readFileCapped, renameAt, writeFileAt } from "./fs-api.js";
import { gitStatus } from "./git.js";
import { appDataDir, isIgnoredDir } from "./paths.js";
import { WorkspaceStore } from "./workspace-store.js";

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
  root: string;
  port: number;
}): Promise<CrystalServer> {
  const store = new WorkspaceStore(opts.root);
  const agents = new AgentManager(opts.root, appDataDir(opts.root));
  const codemap = new CodeMapAnalyzer(opts.root);

  // Warm the workspace (creates .crystal/ on first run) before accepting clients.
  await store.load();

  const handlers: Handlers = {
    "workspace.get": () => store.load(),
    "workspace.saveManifest": async ({ manifest }) => {
      await store.saveManifest(manifest);
      broadcast("workspace.changed", {});
      return { ok: true };
    },
    "arch.save": async ({ path: p, graph }) => {
      await store.saveArchitecture(p, graph);
      return { ok: true };
    },
    "arch.create": ({ name }) => store.createArchitecture(name),
    "arch.delete": async ({ path: p }) => {
      await store.deleteArchitecture(p);
      broadcast("workspace.changed", {});
      return { ok: true };
    },
    "project.save": async ({ path: p, project }) => {
      await store.saveProject(p, project);
      return { ok: true };
    },
    "project.create": ({ name }) => store.createProject(name),
    "fs.list": async ({ path: p }) => ({ entries: await listDir(opts.root, p) }),
    "fs.read": ({ path: p }) => readFileCapped(opts.root, p),
    "fs.write": async ({ path: p, content }) => {
      await writeFileAt(opts.root, p, content);
      return { ok: true };
    },
    "fs.mkdir": async ({ path: p }) => {
      await mkdirAt(opts.root, p);
      return { ok: true };
    },
    "fs.rename": async ({ from, to }) => {
      await renameAt(opts.root, from, to);
      return { ok: true };
    },
    "fs.delete": async ({ path: p }) => {
      await deleteAt(opts.root, p);
      return { ok: true };
    },
    "git.status": ({ repoPath }) => gitStatus(opts.root, repoPath),
    "agent.start": async (params) => ({ run: await agents.start(params) }),
    "agent.cancel": async ({ runId }) => {
      await agents.cancel(runId);
      return { ok: true };
    },
    "agent.list": async () => ({ runs: await agents.list() }),
    "agent.events": async ({ runId }) => ({ events: await agents.eventsFor(runId) }),
    "agent.diff": ({ runId }) => agents.diff(runId),
    "agent.cleanupWorktree": async ({ runId }) => {
      await agents.cleanupWorktree(runId);
      return { ok: true };
    },
    "codemap.get": () => codemap.summary(),
    "codemap.module": ({ path: p }) => codemap.moduleDetail(p),
    "codemap.file": ({ path: p }) => codemap.fileDetail(p),
  };

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, root: opts.root }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: BRIDGE_PATH });
  const clients = new Set<WebSocket>();

  function broadcast<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    const msg: BridgeEventMessage<E> = { type: "evt", event, payload };
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  agents.events.on("event", (payload) => broadcast("agent.event", payload));
  agents.events.on("runChanged", (payload) => broadcast("agent.runChanged", payload));

  // Debounced recursive file watcher → fs.changed events.
  const pendingPaths = new Set<string>();
  let watchTimer: NodeJS.Timeout | null = null;
  let watcher: fsSync.FSWatcher | null = null;
  try {
    watcher = fsSync.watch(opts.root, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join("/");
      if (rel.split("/").some((part) => isIgnoredDir(part))) return;
      pendingPaths.add(rel);
      watchTimer ??= setTimeout(() => {
        watchTimer = null;
        const paths = [...pendingPaths];
        pendingPaths.clear();
        broadcast("fs.changed", { paths });
        if (paths.some((p) => CODE_FILE_RE.test(p))) {
          codemap.invalidate();
          broadcast("codemap.changed", {});
        }
      }, 250);
    });
  } catch (err) {
    console.warn("[crystal] fs watch unavailable:", (err as Error).message);
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
    httpServer.listen(opts.port, "127.0.0.1", () => resolve());
  });

  console.log(
    `[crystal] bridge server on ws://127.0.0.1:${opts.port}${BRIDGE_PATH} (root: ${path.resolve(opts.root)})`,
  );

  return {
    port: opts.port,
    close: async () => {
      watcher?.close();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
