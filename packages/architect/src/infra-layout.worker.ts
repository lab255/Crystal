// @ts-expect-error Vite resolves the asset URL query during worker bundling.
import elkBundleUrl from "elkjs/lib/elk.bundled.js?url";
import type ElkConstructor from "elkjs/lib/elk.bundled.js";
import { solveInfraTargetLayout, type InfraTargetLayoutInput } from "./infra-layout.js";

// elkjs's UMD wrapper interprets `document` being absent while `self` exists as
// meaning that this module is ELK's own worker entry. In a real worker it then
// installs self.onmessage and exports nothing. Make this scope look like the
// main-thread branch before dynamically importing its asset URL (a normal static
// import is hoisted), so the bundled fake worker runs synchronously in this worker.
(globalThis as unknown as { document?: object }).document ??= {};
const elk = import(/* @vite-ignore */ elkBundleUrl).then(() => {
  const ELK = (globalThis as unknown as { ELK: typeof ElkConstructor }).ELK;
  return new ELK({ workerFactory: undefined });
});

self.onmessage = async (event: MessageEvent<{ reqId: number; input: InfraTargetLayoutInput }>) => {
  const { reqId, input } = event.data;
  try {
    self.postMessage({ reqId, output: await solveInfraTargetLayout(input, await elk) });
  } catch (error) {
    self.postMessage({ reqId, error: (error as Error).message });
  }
};
