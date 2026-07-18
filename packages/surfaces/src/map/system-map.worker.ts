import { buildSystemMapLayout, type SystemMapLayoutInput } from "./scene.js";

/**
 * Module worker hosting the surfaces system-map layout (per-band dagre) off
 * the UI thread. Selection decoration stays on the main thread — see
 * SystemMapView's two-phase build. Protocol: useWorkerMemo in @crystal/client.
 */
self.onmessage = (e: MessageEvent<{ reqId: number; input: SystemMapLayoutInput }>) => {
  const { reqId, input } = e.data;
  try {
    self.postMessage({ reqId, output: buildSystemMapLayout(input) });
  } catch (err) {
    self.postMessage({ reqId, error: (err as Error).message });
  }
};
