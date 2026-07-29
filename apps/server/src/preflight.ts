import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  nowIso,
  parseAsserts,
  toolNeedsForMarkers,
  type EnvCheck,
  type EnvReport,
  type PremiseCheck,
  type PremiseReport,
} from "@crystal/core";
import { envWithToolchain, findOnPath } from "./claude-bin.js";
import { runGit } from "./git.js";

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

/** How long one `assert: cmd …` may run before it counts as failed. */
const ASSERT_CMD_TIMEOUT_MS = 30_000;

/**
 * The probing half of the premise check (rules in core/premise.ts): verify a
 * brief's `assert:` claims against the real repo at `root`. Returns null when
 * the text carries no assertions — "nothing was claimed" must stay
 * distinguishable from "everything held". Probes never throw: an unprobeable
 * claim is reported as a failed one, because a claim the checker could not
 * verify is not a claim that held.
 */
export async function probeAssertions(
  root: string,
  text: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    execPath?: string;
  } = {},
): Promise<PremiseReport | null> {
  const asserts = parseAsserts(text);
  if (!asserts.length) return null;
  // Same env agents spawn with, so `tool`/`cmd` claims are judged against the
  // PATH the work will actually see — not this process's bare inherited env.
  const env = envWithToolchain({ ...(opts.env ?? process.env) }, [root], {
    platform: opts.platform,
    home: opts.home,
    execPath: opts.execPath,
  });
  const platform = opts.platform ?? process.platform;

  const checks: PremiseCheck[] = [];
  for (const a of asserts) {
    if (a.kind == null) {
      checks.push({
        kind: "cmd",
        arg: a.arg,
        raw: a.raw,
        ok: false,
        detail: "unrecognized assertion — use branch/ref/file/tool/cmd",
      });
      continue;
    }
    let ok = false;
    let detail: string | null = null;
    try {
      switch (a.kind) {
        case "branch": {
          const local = await runGit(root, [
            "show-ref", "--verify", "--quiet", `refs/heads/${a.arg}`,
          ]).then(() => true, () => false);
          const remote = local
            ? false
            : await runGit(root, [
                "show-ref", "--verify", "--quiet", `refs/remotes/origin/${a.arg}`,
              ]).then(() => true, () => false);
          ok = local || remote;
          detail = ok ? (local ? "local branch" : "origin branch") : "no such local or origin branch";
          break;
        }
        case "ref": {
          const sha = await runGit(root, ["rev-parse", "--verify", "--quiet", a.arg]).then(
            (out) => out.trim(),
            () => null,
          );
          ok = sha != null && sha.length > 0;
          detail = ok ? sha!.slice(0, 12) : "does not resolve in this repo";
          break;
        }
        case "file": {
          ok = await fs.access(path.resolve(root, a.arg)).then(() => true, () => false);
          detail = ok ? "exists" : "not found under the workspace root";
          break;
        }
        case "tool": {
          const resolved = await findOnPath(a.arg, env, platform);
          ok = resolved != null;
          detail = ok ? resolved : "not resolvable on the agents' PATH";
          break;
        }
        case "cmd": {
          const result = await new Promise<{ ok: boolean; detail: string | null }>((resolve) => {
            exec(
              a.arg,
              { cwd: root, env, timeout: ASSERT_CMD_TIMEOUT_MS, windowsHide: true },
              (err, _stdout, stderr) => {
                if (!err) return resolve({ ok: true, detail: "exit 0" });
                const firstErr = String(stderr ?? "").split("\n").find((l) => l.trim()) ?? err.message;
                resolve({ ok: false, detail: firstErr.trim().slice(0, 200) || "non-zero exit" });
              },
            );
          });
          ok = result.ok;
          detail = result.detail;
          break;
        }
      }
    } catch (err) {
      ok = false;
      detail = (err as Error).message.slice(0, 200);
    }
    checks.push({ kind: a.kind, arg: a.arg, raw: a.raw, ok, detail });
  }
  return { checkedAt: nowIso(), ok: checks.every((c) => c.ok), checks };
}
