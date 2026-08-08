import { parentPort, workerData } from "node:worker_threads";
import type { CodeMapProgress } from "@crystal/core";
import { CodeMapAnalyzer } from "./code-map.js";

/**
 * Worker-thread host for one workspace's CodeMapAnalyzer. All the synchronous
 * TypeScript parsing, call-graph walks and surfaces builds run here, keeping
 * the bridge server's event loop free to answer requests and pump terminals.
 * Protocol: `{id, method, args}` in, request replies plus one-way
 * `{type: "progress", progress}` messages out. Everything crosses the
 * boundary via structured clone (Maps survive).
 */

const port = parentPort;
if (!port) throw new Error("analysis-worker must run as a worker thread");

const { root, ws } = workerData as { root: string; ws: string };
const codemap = new CodeMapAnalyzer(root, (progress) => {
  const payload: CodeMapProgress = { ws, ...progress };
  port.postMessage({ type: "progress", progress: payload });
});
const target = codemap as unknown as Record<string, (...args: unknown[]) => unknown>;

port.on("message", (msg: { id: number; method: string; args: unknown[] }) => {
  void (async () => {
    try {
      const fn = target[msg.method];
      if (typeof fn !== "function") throw new Error(`Unknown analysis method: ${msg.method}`);
      const result = await fn.apply(codemap, msg.args);
      port.postMessage({ type: "reply", id: msg.id, ok: true, result });
    } catch (err) {
      port.postMessage({ type: "reply", id: msg.id, ok: false, error: (err as Error).message });
    }
  })();
});

port.postMessage({ type: "ready" });
