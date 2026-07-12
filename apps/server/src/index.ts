import { DEFAULT_BRIDGE_PORT } from "@crystal/core";
import { canonicalRoot } from "./workspace-registry.js";
import { startCrystalServer } from "./server.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** All values of a repeatable flag, e.g. `--root a --root b`. */
function argValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
}

const roots = argValues("--root").map(canonicalRoot);
if (roots.length === 0) roots.push(canonicalRoot(process.cwd()));
const port = Number(argValue("--port") ?? process.env.CRYSTAL_PORT ?? DEFAULT_BRIDGE_PORT);
// Loopback by default; a non-loopback host forces a token (see server.ts).
const host = argValue("--host") ?? process.env.CRYSTAL_HOST ?? "127.0.0.1";
const token = process.env.CRYSTAL_TOKEN ?? null;

startCrystalServer({ root: roots, port, host, token }).catch((err) => {
  console.error("[crystal] failed to start:", err);
  process.exit(1);
});
