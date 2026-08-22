/// <reference lib="webworker" />
import ELK from "elkjs/lib/elk.bundled.js";
import { elkAutoLayout } from "./elk-layout.js";
import {
  decodeElkLayoutRequest,
  encodeElkLayoutReply,
  type ElkWorkerReply,
  type ElkWorkerRequest,
} from "./elk-layout-protocol.js";

const engine = new ELK();

self.onmessage = async (event: MessageEvent<ElkWorkerRequest>) => {
  const { reqId, input } = event.data;
  let reply: ElkWorkerReply;
  try {
    const decoded = decodeElkLayoutRequest(input);
    reply = {
      reqId,
      output: encodeElkLayoutReply(await elkAutoLayout(decoded.graph, decoded.opts, engine)),
    };
  } catch (error) {
    reply = { reqId, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
