import ELK from "elkjs/lib/elk.bundled.js";
import { solveInfraTargetLayout, type InfraTargetLayoutInput } from "./infra-layout.js";

const elk = new ELK();

self.onmessage = async (event: MessageEvent<{ reqId: number; input: InfraTargetLayoutInput }>) => {
  const { reqId, input } = event.data;
  try {
    self.postMessage({ reqId, output: await solveInfraTargetLayout(input, elk) });
  } catch (error) {
    self.postMessage({ reqId, error: (error as Error).message });
  }
};
