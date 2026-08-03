// OpenAI Codex CLI specifics: binary resolution and argv planning. The
// stream normalization lives in @crystal/core (codex.ts) — this file is the
// server half, mirroring claude-bin.ts / the claude*Args builders in
// agent-manager.ts for the second provider.
//
// Verified contract (documented Codex CLI ≥0.20, Rust; the binary was not
// installed on the dev machine when this was written — see docs/agent-ops.md):
//
//   headless   codex exec --json [--model m] [--sandbox …] [resume <THREAD>] -
//              (prompt on stdin via the "-" arg — user text never rides argv,
//              same rule as the Claude spawns)
//   resume     codex exec resume <THREAD_ID> … -
//   interactive codex  (TUI on a PTY; approvals are native)
//
// The JSONL it emits is parsed by CodexStreamParser in @crystal/core.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPermissionMode } from "@crystal/core";
import { findOnPath, isBareName, loginShellLookup } from "./claude-bin.js";

/**
 * Install locations the Codex CLI lands in when PATH doesn't say (npm
 * `@openai/codex` global installs, Homebrew, cargo). The same GUI-launch
 * reasoning as {@link claudeFallbackDirs}: a desktop sidecar's PATH is bare.
 */
export function codexFallbackDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(home, ".local", "bin"),
      ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []),
      ...(env.PNPM_HOME ? [env.PNPM_HOME] : []),
      path.join(local, "pnpm"),
      ...(env.VOLTA_HOME ? [path.join(env.VOLTA_HOME, "bin")] : []),
      path.join(local, "Volta", "bin"),
      path.join(home, "scoop", "shims"),
      path.join(home, ".cargo", "bin"),
      path.join(local, "fnm", "aliases", "default"),
      path.join(local, "fnm", "aliases", "default", "installation"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "n", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "bin"),
  ];
}

export interface ResolveCodexOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Login-shell fallback; injectable so tests never spawn a shell. */
  shellLookup?: (bin: string) => Promise<string | null>;
}

/**
 * Resolve the configured Codex binary to something spawnable — same ladder as
 * `resolveClaudeBin`: explicit paths pass through; a bare name is searched on
 * this process's PATH, then the known install dirs, then (POSIX) the login
 * shell. A total miss keeps the bare name so the spawn surfaces as a failed
 * run with a legible error, never a server crash.
 */
export async function resolveCodexBin(
  bin: string,
  opts: ResolveCodexOptions = {},
): Promise<string> {
  if (!isBareName(bin)) return bin;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const onPath = await findOnPath(bin, env, platform);
  if (onPath) return onPath;
  // Fallback dirs reuse findOnPath by treating the list as a synthetic PATH.
  const dirs = codexFallbackDirs(platform, home, env);
  const existing: string[] = [];
  for (const dir of dirs) {
    if (await fs.access(dir).then(() => true, () => false)) existing.push(dir);
  }
  if (existing.length) {
    const known = await findOnPath(bin, { PATH: existing.join(path.delimiter) }, platform);
    if (known) return known;
  }
  if (platform !== "win32") {
    const lookup = opts.shellLookup ?? loginShellLookup;
    const fromShell = await lookup(bin);
    if (fromShell) return fromShell;
  }
  return bin;
}

/**
 * Map Crystal's (Claude-vocabulary) permission modes onto Codex's sandbox
 * levels. Codex has no per-tool allowlists or permission prompts — the
 * sandbox *is* its permission model:
 *
 * - default / plan → `read-only` (observe, don't touch)
 * - acceptEdits (Crystal's headless default) → `workspace-write`
 * - bypassPermissions → `danger-full-access`; of the two documented escape
 *   hatches this is the safer one — it widens the sandbox without also
 *   switching off approval policy wholesale the way
 *   `--dangerously-bypass-approvals-and-sandbox` does. It still only ever
 *   applies after the workspace's bypass gate consented.
 */
export function codexSandboxArgs(mode: AgentPermissionMode | null | undefined): string[] {
  switch (mode) {
    case "default":
    case "plan":
      return ["--sandbox", "read-only"];
    case "bypassPermissions":
      return ["--sandbox", "danger-full-access"];
    case "acceptEdits":
    default:
      return ["--sandbox", "workspace-write"];
  }
}

/**
 * Argv for one headless codex run. `--json` gives the JSONL event stream
 * (CodexStreamParser's input); the trailing "-" makes the prompt arrive on
 * stdin — user text never rides argv. `--skip-git-repo-check` keeps parity
 * with Claude runs, which have no such precondition (the hub's manager cwd,
 * for one, is not a repo). Resume re-enters an existing thread; everything
 * Claude-specific (mcp-config, --append-system-prompt, tool lists,
 * --permission-prompt-tool) has no counterpart here — see agent-manager.ts
 * for how each degrades.
 */
export function codexExecArgs(opts: {
  model?: string | null;
  resumeSessionId?: string | null;
  permissionMode?: AgentPermissionMode | null;
}): string[] {
  const args = ["exec"];
  if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId);
  args.push("--json", "--skip-git-repo-check");
  args.push(...codexSandboxArgs(opts.permissionMode));
  if (opts.model) args.push("--model", opts.model);
  args.push("-");
  return args;
}

/**
 * Argv for an *interactive* codex session (the native TUI on a PTY). No
 * `--json` — the TUI renders itself, and its approval prompts are the
 * permission surface (the owner is at the terminal). Unlike Claude there is
 * no `--session-id` to pin: the thread id is never learnable from a TUI, so
 * an interactive codex chain is NOT headlessly resumable after its terminal
 * closes — prepareInteractive records that degradation on the run.
 */
export function codexInteractiveArgs(opts: {
  model?: string | null;
  permissionMode?: AgentPermissionMode | null;
}): string[] {
  const args: string[] = [];
  args.push(...codexSandboxArgs(opts.permissionMode));
  if (opts.model) args.push("--model", opts.model);
  return args;
}
