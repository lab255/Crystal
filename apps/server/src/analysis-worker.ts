import { parentPort, workerData } from "node:worker_threads";
import { CodeMapAnalyzer } from "./code-map.js";

/**
 * Worker-thread host for one workspace's CodeMapAnalyzer. All the synchronous
 * TypeScript parsing, call-graph walks and surfaces builds run here, keeping
 * the bridge server's event loop free to answer requests and pump terminals.
 * Protocol: `{id, method, args}` in, `{id, ok, result|error}` out; results
 * cross the boundary via structured clone (Maps survive).
 */

const port = parentPort;
if (!port) throw new Error("analysis-worker must run as a worker thread");

const codemap = new CodeMapAnalyzer((workerData as { root: string }).root);
const target = codemap as unknown as Record<string, (...args: unknown[]) => unknown>;

port.on("message", (msg: { id: number; method: string; args: unknown[] }) => {
  void (async () => {
    try {
      const fn = target[msg.method];
      if (typeof fn !== "function") throw new Error(`Unknown analysis method: ${msg.method}`);
      const result = await fn.apply(codemap, msg.args);
      port.postMessage({ id: msg.id, ok: true, result });
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: (err as Error).message });
    }
  })();
});

port.postMessage({ type: "ready" });
