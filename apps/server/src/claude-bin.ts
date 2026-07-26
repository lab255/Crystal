// Resolution of the Claude CLI binary. The bridge server can't assume a
// terminal's environment: under the desktop app the sidecar inherits the GUI
// launch context — launchd hands macOS apps a bare `/usr/bin:/bin:...` PATH,
// so the `claude` a user runs every day in their terminal simply isn't
// findable, and the POSIX spawn of the bare name dies with
// "spawn claude ENOENT" on the first manager dispatch. Resolution therefore
// goes: the process's own PATH → well-known install locations → (POSIX) the
// user's login shell. Whatever wins is also prepended to the child's PATH so
// the CLI can find its own helpers.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows executable extensions, in where.exe's preference order. */
const WIN_EXTS = [".exe", ".cmd", ".bat"];

/** A name with no separators or extension — the only thing worth resolving. */
export function isBareName(bin: string): boolean {
  return !/[\\/.]/.test(bin);
}

/**
 * Install locations the Claude CLI actually lands in when PATH doesn't say:
 * the native installer (`~/.local/bin`), `claude migrate-installer`
 * (`~/.claude/local`), Homebrew, and the common npm-global homes. Ordered
 * most-likely first; a GUI-launched sidecar sees none of these on PATH.
 */
export function claudeFallbackDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    return [
      path.join(home, ".local", "bin"),
      ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "n", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "bin"),
  ];
}

async function executableIn(
  dir: string,
  bin: string,
  win: boolean,
): Promise<string | null> {
  const names = win ? WIN_EXTS.map((ext) => bin + ext) : [bin];
  for (const name of names) {
    const file = path.join(dir, name);
    // X_OK is meaningless on Windows — existence is the best check there.
    const ok = await fs
      .access(file, win ? fs.constants.F_OK : fs.constants.X_OK)
      .then(() => true, () => false);
    if (ok) return file;
  }
  return null;
}

async function scanDirs(
  dirs: string[],
  bin: string,
  win: boolean,
): Promise<string | null> {
  for (const dir of dirs) {
    if (!dir) continue;
    const found = await executableIn(dir, bin, win);
    if (found) return found;
  }
  return null;
}

/**
 * Ask the user's login+interactive shell where `bin` is — the catch-all for
 * version managers (nvm, fnm, asdf) whose PATH edits live in rc files no
 * static list can know. Interactive because that's where nvm-style init
 * usually sits; a timeout bounds a chatty rc file. Never throws.
 */
export async function loginShellLookup(bin: string): Promise<string | null> {
  // The name is interpolated into a shell command line — plain names only.
  if (!/^[\w-]+$/.test(bin)) return null;
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const { stdout } = await execFileAsync(shell, ["-l", "-i", "-c", `command -v ${bin}`], {
      timeout: 3000,
      encoding: "utf8",
    });
    // rc files may print; the answer is the last absolute path emitted.
    const lines = stdout.split("\n").map((l) => l.trim());
    return lines.reverse().find((l) => l.startsWith("/")) ?? null;
  } catch {
    return null;
  }
}

export interface ResolveClaudeOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Login-shell fallback; injectable so tests never spawn a shell. */
  shellLookup?: (bin: string) => Promise<string | null>;
}

/**
 * Resolve the configured Claude binary to something spawnable. An explicit
 * path (or anything carrying an extension) passes through untouched. A bare
 * name is searched on this process's PATH first (a terminal-launched server
 * finds it immediately), then the well-known install dirs, then the login
 * shell. When everything misses the bare name survives — the spawn then
 * fails as a failed *run* with a legible error, not a server crash.
 */
export async function resolveClaudeBin(
  bin: string,
  opts: ResolveClaudeOptions = {},
): Promise<string> {
  if (!isBareName(bin)) return bin;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const win = platform === "win32";
  const pathValue = env[pathKey(env)] ?? "";
  const onPath = await scanDirs(pathValue.split(path.delimiter), bin, win);
  if (onPath) return onPath;
  const known = await scanDirs(claudeFallbackDirs(platform, home, env), bin, win);
  if (known) return known;
  if (!win) {
    const lookup = opts.shellLookup ?? loginShellLookup;
    const fromShell = await lookup(bin);
    if (fromShell) return fromShell;
  }
  return bin;
}

/** The env's actual PATH key — Windows spells it `Path` (any case wins). */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * The spawn env with the resolved binary's directory prepended to PATH — a
 * CLI found outside the inherited PATH must still be able to spawn its own
 * helpers (and re-invoke itself). Mutating the *existing* key, not always
 * `PATH`: on Windows a spread adding `PATH` beside an inherited `Path` puts
 * two case-colliding keys in the env block, and which one the child sees is
 * anyone's guess.
 */
export function envWithBinDir(
  env: NodeJS.ProcessEnv,
  binPath: string,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(binPath)) return env;
  const dir = path.dirname(binPath);
  const key = pathKey(env);
  const current = env[key] ?? "";
  if (current.split(path.delimiter).includes(dir)) return env;
  return { ...env, [key]: current ? dir + path.delimiter + current : dir };
}
