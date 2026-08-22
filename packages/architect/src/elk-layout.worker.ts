/// <reference lib="webworker" />
// @ts-expect-error Vite resolves the asset URL query during worker bundling.
import elkBundleUrl from "elkjs/lib/elk.bundled.js?url";
import type ElkConstructor from "elkjs/lib/elk.bundled.js";
import { elkAutoLayout } from "./elk-layout.js";
import {
  decodeElkLayoutRequest,
  encodeElkLayoutReply,
  type ElkWorkerReply,
  type ElkWorkerRequest,
} from "./elk-layout-protocol.js";

// elkjs's UMD wrapper interprets `document` being absent while `self` exists as
// meaning that this module is ELK's own worker entry. In a real worker it then
// installs self.onmessage and exports nothing. Make this scope look like the
// main-thread branch before dynamically importing its asset URL (a normal static
// import is hoisted), so the bundled fake worker runs synchronously in this worker.
(globalThis as unknown as { document?: object }).document ??= {};
const engine = import(/* @vite-ignore */ elkBundleUrl).then(() => {
  const ELK = (globalThis as unknown as { ELK: typeof ElkConstructor }).ELK;
  return new ELK({ workerFactory: undefined });
});

self.onmessage = async (event: MessageEvent<ElkWorkerRequest>) => {
  const { reqId, input } = event.data;
  let reply: ElkWorkerReply;
  try {
    const decoded = decodeElkLayoutRequest(input);
    reply = {
      reqId,
      output: encodeElkLayoutReply(await elkAutoLayout(decoded.graph, decoded.opts, await engine)),
    };
  } catch (error) {
    reply = { reqId, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
