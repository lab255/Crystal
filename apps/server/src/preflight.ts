import fs from "node:fs/promises";
import {
  nowIso,
  toolNeedsForMarkers,
  type EnvCheck,
  type EnvReport,
} from "@crystal/core";
import { envWithToolchain, findOnPath } from "./claude-bin.js";

/**
 * The probing half of the dispatch pre-flight (rules in core/preflight.ts):
 * read the workspace root's marker files, derive the tools the work implies,
 * and resolve each against the PATH agents will actually spawn with —
 * {@link envWithToolchain}, not this process's bare inherited env, so the
 * report matches what a worker's `pnpm test` really sees.
 */
export async function probeEnvironment(
  root: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Injectable (with execPath) so tests probe a sealed PATH, not the host's. */
    home?: string;
    execPath?: string;
  } = {},
): Promise<EnvReport> {
  const markers = await fs.readdir(root).catch(() => [] as string[]);
  const needs = toolNeedsForMarkers(markers);
  const env = envWithToolchain({ ...(opts.env ?? process.env) }, [root], {
    platform: opts.platform,
    home: opts.home,
    execPath: opts.execPath,
  });
  const platform = opts.platform ?? process.platform;
  const checks: EnvCheck[] = [];
  for (const need of needs) {
    let resolved: string | null = null;
    for (const bin of need.bins) {
      resolved = await findOnPath(bin, env, platform);
      if (resolved) break;
    }
    checks.push({ ...need, ok: resolved != null, resolved });
  }
  return { checkedAt: nowIso(), ok: checks.every((c) => c.ok), checks };
}
