import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BRIDGE_PORT } from "@crystal/core";
import { startCrystalServer } from "./server.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** realpath expands Windows 8.3 short paths, which crash libuv's recursive fs watcher. */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const root = canonical(argValue("--root") ?? process.cwd());
const port = Number(argValue("--port") ?? process.env.CRYSTAL_PORT ?? DEFAULT_BRIDGE_PORT);

startCrystalServer({ root, port }).catch((err) => {
  console.error("[crystal] failed to start:", err);
  process.exit(1);
});
