import { INSTANCE_ID_RE } from "./protocol.js";
import type { Env } from "./relay-do.js";

export { BridgeRelayDO } from "./relay-do.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "i" && INSTANCE_ID_RE.test(parts[1]!)) {
      const id = env.RELAY.idFromName(parts[1]!);
      return env.RELAY.get(id).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
