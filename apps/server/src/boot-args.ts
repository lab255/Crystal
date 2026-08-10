/**
 * Startup-root resolution, pure so the boot contract is unit-testable (index.ts
 * is all side effects the moment it is imported).
 *
 * `--root` is repeatable and always wins. With none given a CLI user means
 * "the directory I'm standing in", so the cwd is the fallback — but a GUI
 * launch has no meaningful cwd, and force-opening one would rob a first-launch
 * user of the workspace picker. `--no-default-root` (or `CRYSTAL_NO_DEFAULT_ROOT=1`,
 * for supervisors that can only set env) drops that fallback: the server boots
 * with zero CLI roots and opens only what the previous session persisted.
 */

const NO_DEFAULT_ROOT_FLAG = "--no-default-root";
const NO_DEFAULT_ROOT_ENV = "CRYSTAL_NO_DEFAULT_ROOT";

/** All values of a repeatable flag, e.g. `--root a --root b`. */
export function flagValues(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]!);
  }
  return out;
}

/** Whether the cwd fallback is suppressed (flag or env). */
export function noDefaultRoot(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  return argv.includes(NO_DEFAULT_ROOT_FLAG) || env[NO_DEFAULT_ROOT_ENV] === "1";
}

/**
 * The roots to open at startup, in order (the first becomes the default
 * workspace). May be empty — a server with no workspace open is a legitimate
 * state (the client lands on the Overview and its picker).
 */
export function resolveStartupRoots(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): string[] {
  const roots = flagValues(argv, "--root");
  if (roots.length > 0 || noDefaultRoot(argv, env)) return roots;
  return [cwd];
}
