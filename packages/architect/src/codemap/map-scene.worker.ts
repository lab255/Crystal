import { buildMapScene, type MapSceneInput } from "./map-model.js";

/**
 * Module worker hosting the code-map scene build (multiple dagre passes at
 * FormSG scale) off the UI thread. Protocol: see useWorkerMemo in
 * @crystal/client.
 */
self.onmessage = (e: MessageEvent<{ reqId: number; input: MapSceneInput }>) => {
  const { reqId, input } = e.data;
  try {
    self.postMessage({ reqId, output: buildMapScene(input) });
  } catch (err) {
    self.postMessage({ reqId, error: (err as Error).message });
  }
};
