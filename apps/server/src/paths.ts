import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Resolve a workspace-relative path safely inside the root (blocks traversal). */
export function resolveInRoot(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, cleaned);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes workspace root: ${rel}`);
  }
  return abs;
}

/** Workspace-relative forward-slash path for an absolute path. */
export function toRelPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Stable workspace id derived from the canonical root path. */
export function workspaceIdFor(root: string): string {
  return crypto
    .createHash("sha1")
    .update(path.resolve(root).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

/** Per-workspace app-data directory (run history, ephemeral state). */
export function appDataDir(root: string): string {
  const base = path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9-_]/g, "-");
  return path.join(os.homedir(), ".crystal", "workspaces", `${base}-${workspaceIdFor(root)}`);
}

/**
 * The hub's own directory: cross-project programs and the program-manager
 * sessions that drive them. Deliberately outside `workspaces/` — a program
 * belongs to no single project.
 */
export function hubDataDir(): string {
  return path.join(os.homedir(), ".crystal", "hub");
}

/**
 * The shared workflow-template library. Outside `workspaces/` for the same
 * reason the hub is: a template describes a *shape of work*, not a repo, and
 * the hub dispatches one program's deliveries into several projects that
 * should be able to name the same shape.
 */
export function globalTemplatesDir(): string {
  return path.join(os.homedir(), ".crystal", "workflow-templates");
}

/**
 * The shared agent-profile library. Outside `workspaces/` for the same reason
 * templates are: a profile describes *who runs*, not a repo — and it is what
 * the hub (which belongs to no project) resolves agent ids against.
 */
export function globalAgentsDir(): string {
  return path.join(os.homedir(), ".crystal", "agents");
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
]);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}
