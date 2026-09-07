import { parentPort } from "node:worker_threads";
import { jobs, type JobName, type JobArgs } from "./job-registry.js";

const port = parentPort;
if (!port) throw new Error("jobs-worker must run as a worker thread");

port.on("message", (msg: { id: number; name: JobName; args: JobArgs }) => {
  void (async () => {
    try {
      if (!Object.hasOwn(jobs, msg.name)) throw new Error(`Unknown job: ${msg.name}`);
      const result = await jobs[msg.name](...msg.args);
      port.postMessage({ type: "reply", id: msg.id, ok: true, result });
    } catch (err) {
      port.postMessage({ type: "reply", id: msg.id, ok: false, error: (err as Error).message });
    }
  })();
});
port.postMessage({ type: "ready" });
